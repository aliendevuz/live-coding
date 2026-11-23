//! Project file system access for the host, plus local writes for the guest (clone).
//!
//! Every path that comes from the frontend is *relative* and is resolved with
//! [`resolve`], which refuses anything that would escape the project root. The
//! guest can send arbitrary strings through the data channel, so this is the
//! boundary that keeps it inside the project folder.

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::WalkBuilder;
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, UNIX_EPOCH};
use tauri::ipc::{Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};

/// Folders that are never cloned and never watched: the guest recreates them
/// (npm install, python -m venv) and they are usually huge.
const HEAVY_DIRS: &[&str] = &[
    "node_modules", ".venv", "venv", "env", ".git", "__pycache__", "target", ".next", "dist", "build",
];

fn is_heavy_dir(name: &str) -> bool {
    HEAVY_DIRS.iter().any(|d| d.eq_ignore_ascii_case(name))
}

/// Secrets stay on the host's machine.
pub fn is_secret_file(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == ".env" || (n.starts_with(".env.") && n != ".env.example" && n != ".env.sample")
}

#[derive(Default)]
pub struct Project {
    root: Mutex<Option<PathBuf>>,
    gitignore: Mutex<Option<Gitignore>>,
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

impl Project {
    pub fn root(&self) -> Result<PathBuf, String> {
        self.root.lock().unwrap().clone().ok_or_else(|| "no project open".to_string())
    }
}

/// Resolve `rel` inside `root`, rejecting absolute paths, `..`, and symlink escapes.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.replace('\\', "/");
    let rel = rel.trim_start_matches("./");
    let mut out = root.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            _ => return Err(format!("illegal path: {rel}")),
        }
    }
    // Symlink / junction check: the deepest existing ancestor must stay under root.
    let canon_root = dunce_canon(root)?;
    let mut probe = out.clone();
    while !probe.exists() {
        if !probe.pop() {
            break;
        }
    }
    let canon = dunce_canon(&probe)?;
    if !canon.starts_with(&canon_root) {
        return Err(format!("path escapes project: {rel}"));
    }
    Ok(out)
}

fn dunce_canon(p: &Path) -> Result<PathBuf, String> {
    let c = std::fs::canonicalize(p).map_err(|e| format!("{}: {e}", p.display()))?;
    // Strip the \\?\ prefix Windows adds so starts_with comparisons are consistent.
    let s = c.to_string_lossy();
    Ok(PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()))
}

fn to_rel(root: &Path, abs: &Path) -> Option<String> {
    abs.strip_prefix(root).ok().map(|p| p.to_string_lossy().replace('\\', "/"))
}

#[derive(Serialize)]
pub struct Entry {
    name: String,
    dir: bool,
    size: u64,
    mtime: u64,
    /// Heavy folder, secret, or matched by .gitignore: shown, never cloned.
    ignored: bool,
}

#[derive(Serialize)]
pub struct OpenedProject {
    name: String,
    path: String,
}

#[tauri::command]
pub fn project_open(
    app: AppHandle,
    project: State<'_, Project>,
    path: String,
) -> Result<OpenedProject, String> {
    let root = dunce_canon(Path::new(&path))?;
    if !root.is_dir() {
        return Err("not a folder".into());
    }
    let mut gb = GitignoreBuilder::new(&root);
    gb.add(root.join(".gitignore"));
    *project.gitignore.lock().unwrap() = gb.build().ok();
    *project.root.lock().unwrap() = Some(root.clone());
    *project.watcher.lock().unwrap() = Some(start_watcher(app, root.clone())?);
    Ok(OpenedProject {
        name: root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        path: root.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn fs_list(project: State<'_, Project>, rel: String) -> Result<Vec<Entry>, String> {
    let root = project.root()?;
    let dir = resolve(&root, &rel)?;
    let gi = project.gitignore.lock().unwrap();
    let mut out = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(e) = e else { continue };
        let Ok(md) = e.metadata() else { continue };
        let name = e.file_name().to_string_lossy().into_owned();
        let dir = md.is_dir();
        let ignored = (dir && is_heavy_dir(&name))
            || (!dir && is_secret_file(&name))
            || gi
                .as_ref()
                .map(|g| g.matched_path_or_any_parents(e.path(), dir).is_ignore())
                .unwrap_or(false);
        out.push(Entry {
            name,
            dir,
            size: if dir { 0 } else { md.len() },
            mtime: mtime_ms(&md),
            ignored,
        });
    }
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

fn mtime_ms(md: &std::fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize)]
pub struct Stat {
    size: u64,
    mtime: u64,
    hash: String,
}

/// Size, mtime and content hash; the guest uses the hash to reuse its cache.
#[tauri::command]
pub async fn fs_stat(project: State<'_, Project>, rel: String) -> Result<Stat, String> {
    let path = resolve(&project.root()?, &rel)?;
    tauri::async_runtime::spawn_blocking(move || {
        let md = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        let mut h = blake3::Hasher::new();
        let mut f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut h).map_err(|e| e.to_string())?;
        Ok(Stat { size: md.len(), mtime: mtime_ms(&md), hash: h.finalize().to_hex().to_string() })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Raw bytes of a file (ArrayBuffer on the JS side).
#[tauri::command]
pub async fn fs_read(project: State<'_, Project>, rel: String) -> Result<Response, String> {
    let path = resolve(&project.root()?, &rel)?;
    let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

/// A slice of a file, for streaming large files without loading them whole.
#[tauri::command]
pub async fn fs_read_range(project: State<'_, Project>, rel: String, offset: u64, len: u32) -> Result<Response, String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let path = resolve(&project.root()?, &rel)?;
    let mut f = tokio::fs::File::open(&path).await.map_err(|e| e.to_string())?;
    f.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(len as usize);
    f.take(len as u64).read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
    Ok(Response::new(buf))
}

#[tauri::command]
pub async fn fs_write_text(project: State<'_, Project>, rel: String, text: String) -> Result<(), String> {
    let path = resolve(&project.root()?, &rel)?;
    write_atomic(&path, text.as_bytes()).await
}

/// Binary write into the project: raw body, path in the `x-rel` header.
#[tauri::command]
pub async fn fs_write_bytes(project: State<'_, Project>, request: Request<'_>) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let rel = header(&request, "x-rel")?;
    let path = resolve(&project.root()?, &rel)?;
    let offset: u64 = header(&request, "x-offset").unwrap_or_else(|_| "0".into()).parse().map_err(|_| "bad offset")?;
    if offset == 0 {
        return write_atomic(&path, raw_body(&request)?).await;
    }
    let mut f = tokio::fs::OpenOptions::new().append(true).open(&path).await.map_err(|e| e.to_string())?;
    f.write_all(raw_body(&request)?).await.map_err(|e| e.to_string())
}

async fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }
    // Write in place rather than rename-over: keeps file identity, so editors and
    // dev-server watchers on the host see an ordinary change.
    tokio::fs::write(path, bytes).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fs_create(project: State<'_, Project>, rel: String, dir: bool) -> Result<(), String> {
    let path = resolve(&project.root()?, &rel)?;
    if path.exists() {
        return Err("already exists".into());
    }
    if dir {
        tokio::fs::create_dir_all(&path).await.map_err(|e| e.to_string())
    } else {
        write_atomic(&path, b"").await
    }
}

#[tauri::command]
pub async fn fs_delete(project: State<'_, Project>, rel: String) -> Result<(), String> {
    let root = project.root()?;
    let path = resolve(&root, &rel)?;
    if path == root {
        return Err("refusing to delete the project root".into());
    }
    let md = tokio::fs::symlink_metadata(&path).await.map_err(|e| e.to_string())?;
    if md.is_dir() {
        tokio::fs::remove_dir_all(&path).await.map_err(|e| e.to_string())
    } else {
        tokio::fs::remove_file(&path).await.map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn fs_rename(project: State<'_, Project>, from: String, to: String) -> Result<(), String> {
    let root = project.root()?;
    let a = resolve(&root, &from)?;
    let b = resolve(&root, &to)?;
    if a == root {
        return Err("refusing to rename the project root".into());
    }
    if b.exists() {
        return Err("target exists".into());
    }
    tokio::fs::rename(&a, &b).await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct CloneItem {
    path: String,
    size: u64,
}

/// Files a guest may clone: .gitignore respected, heavy folders and secrets skipped.
#[tauri::command]
pub async fn fs_clone_list(project: State<'_, Project>) -> Result<Vec<CloneItem>, String> {
    let root = project.root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let walker = WalkBuilder::new(&root)
            .hidden(false)
            .git_ignore(true)
            .git_exclude(false)
            .git_global(false)
            .require_git(false)
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                let dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                !(dir && is_heavy_dir(&name)) && !(!dir && is_secret_file(&name))
            })
            .build();
        let mut out = Vec::new();
        for e in walker.flatten() {
            if !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let Some(rel) = to_rel(&root, e.path()) else { continue };
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(CloneItem { path: rel, size });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Guest side of clone / download: write bytes under a folder the guest picked.
/// Headers: `x-root` (absolute folder chosen in a dialog), `x-rel`, `x-offset`
/// (0 creates or truncates the file, anything else appends).
#[tauri::command]
pub async fn local_write(request: Request<'_>) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let root = PathBuf::from(header(&request, "x-root")?);
    if !root.is_absolute() {
        return Err("root must be absolute".into());
    }
    tokio::fs::create_dir_all(&root).await.map_err(|e| e.to_string())?;
    let path = resolve(&root, &header(&request, "x-rel")?)?;
    let offset: u64 = header(&request, "x-offset").unwrap_or_else(|_| "0".into()).parse().map_err(|_| "bad offset")?;
    let bytes = raw_body(&request)?;
    if offset == 0 {
        return write_atomic(&path, bytes).await;
    }
    let mut f = tokio::fs::OpenOptions::new().append(true).open(&path).await.map_err(|e| e.to_string())?;
    f.write_all(bytes).await.map_err(|e| e.to_string())
}

pub fn header(req: &Request<'_>, name: &str) -> Result<String, String> {
    let v = req.headers().get(name).ok_or_else(|| format!("missing header {name}"))?;
    let s = v.to_str().map_err(|e| e.to_string())?;
    // Paths may contain non-ASCII characters: the frontend percent-encodes them.
    percent_decode(s)
}

fn percent_decode(s: &str) -> Result<String, String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

pub fn raw_body<'a>(req: &'a Request<'_>) -> Result<&'a [u8], String> {
    match req.body() {
        tauri::ipc::InvokeBody::Raw(b) => Ok(b),
        _ => Err("expected a raw body".into()),
    }
}

#[derive(Serialize, Clone)]
struct FsChange {
    path: String,
    exists: bool,
    dir: bool,
    /// Newly created in this batch (language servers must re-scan imports).
    created: bool,
}

/// Watches the project and emits debounced `fs-changed` events with relative paths.
fn start_watcher(app: AppHandle, root: PathBuf) -> Result<notify::RecommendedWatcher, String> {
    let (tx, rx) = mpsc::channel::<(PathBuf, bool)>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if matches!(ev.kind, notify::EventKind::Access(_)) {
                return;
            }
            let created = matches!(ev.kind, notify::EventKind::Create(_));
            for p in ev.paths {
                let _ = tx.send((p, created));
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        // Ends when the watcher (and with it `tx`) is dropped.
        while let Ok((first, c)) = rx.recv() {
            let mut batch = HashSet::from([first.clone()]);
            let mut created: HashSet<PathBuf> = HashSet::new();
            if c {
                created.insert(first);
            }
            let deadline = std::time::Instant::now() + Duration::from_millis(150);
            while let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) {
                match rx.recv_timeout(left) {
                    Ok((p, c)) => {
                        if c {
                            created.insert(p.clone());
                        }
                        batch.insert(p);
                    }
                    Err(_) => break,
                }
            }
            let changes: Vec<FsChange> = batch
                .into_iter()
                .filter_map(|abs| {
                    let rel = to_rel(&root, &abs)?;
                    if rel.is_empty() || rel.split('/').any(is_heavy_dir) {
                        return None;
                    }
                    let md = std::fs::metadata(&abs).ok();
                    Some(FsChange {
                        path: rel,
                        exists: md.is_some(),
                        dir: md.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                        created: created.contains(&abs),
                    })
                })
                .collect();
            if !changes.is_empty() {
                let files: Vec<String> = changes.iter().filter(|c| !c.dir).map(|c| c.path.clone()).collect();
                app.state::<crate::liveserver::LiveServer>().changed(&files);
                let _ = app.emit("fs-changed", changes);
            }
        }
    });
    Ok(watcher)
}

// ------------------------------------------------------------------ v3: file management

/// "name.ext" -> "name copy.ext", "name copy 2.ext", ... (VS Code's naming) until free.
fn unique_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let is_dir = path.is_dir();
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && !is_dir => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.clone(), String::new()),
    };
    let mut n = 1u32;
    loop {
        let cand = if n == 1 { format!("{stem} copy{ext}") } else { format!("{stem} copy {n}{ext}") };
        let p = parent.join(cand);
        if !p.exists() {
            return p;
        }
        n += 1;
    }
}

fn copy_recursive(from: &Path, to: &Path) -> std::io::Result<()> {
    let md = std::fs::symlink_metadata(from)?;
    if md.is_dir() {
        std::fs::create_dir_all(to)?;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            copy_recursive(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(())
    } else if md.file_type().is_symlink() {
        Ok(()) // never follow links out of the tree
    } else {
        if let Some(p) = to.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::copy(from, to).map(|_| ())
    }
}

/// Copy a file or folder inside the project. `to` is the wanted path; if it is
/// taken a " copy" name is used. Returns the relative path actually written.
#[tauri::command]
pub async fn fs_copy(project: State<'_, Project>, from: String, to: String) -> Result<String, String> {
    let root = project.root()?;
    let a = resolve(&root, &from)?;
    let b = resolve(&root, &to)?;
    if a == root {
        return Err("cannot copy the project root".into());
    }
    if b.starts_with(&a) && b != a {
        return Err("cannot copy a folder into itself".into());
    }
    let target = unique_path(&b);
    let t2 = target.clone();
    tauri::async_runtime::spawn_blocking(move || copy_recursive(&a, &t2))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    to_rel(&root, &target).ok_or_else(|| "bad target".into())
}

/// Move to the Recycle Bin (recoverable), unlike `fs_delete`.
#[tauri::command]
pub async fn fs_trash(project: State<'_, Project>, rels: Vec<String>) -> Result<(), String> {
    let root = project.root()?;
    let mut paths = Vec::new();
    for r in &rels {
        let p = resolve(&root, r)?;
        if p == root {
            return Err("refusing to delete the project root".into());
        }
        paths.push(p);
    }
    tauri::async_runtime::spawn_blocking(move || trash::delete_all(&paths).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Host: copy files/folders dropped from Windows Explorer into a project folder.
/// Returns the relative paths created (names made unique).
#[tauri::command]
pub async fn fs_import(project: State<'_, Project>, sources: Vec<String>, dir: String) -> Result<Vec<String>, String> {
    let root = project.root()?;
    let dest = resolve(&root, &dir)?;
    tauri::async_runtime::spawn_blocking(move || {
        let canon_root = dunce_canon(&root)?;
        let canon_dest = dunce_canon(&dest).ok();
        let mut out = Vec::new();
        for s in sources {
            let src = PathBuf::from(&s);
            let Some(name) = src.file_name() else { continue };
            // Dropping something that already lives in this folder is a no-op.
            if src.parent().and_then(|p| dunce_canon(p).ok()) == canon_dest {
                continue;
            }
            if let Ok(cs) = dunce_canon(&src) {
                if canon_root.starts_with(&cs) {
                    return Err("cannot import a folder that contains the project".into());
                }
            }
            let target = unique_path(&dest.join(name));
            copy_recursive(&src, &target).map_err(|e| format!("{s}: {e}"))?;
            if let Some(r) = to_rel(&root, &target) {
                out.push(r);
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct PathKind {
    exists: bool,
    dir: bool,
}

/// Is a dropped path a folder? (drag & drop gives only paths)
#[tauri::command]
pub fn path_kind(path: String) -> PathKind {
    let md = std::fs::metadata(&path).ok();
    PathKind { exists: md.is_some(), dir: md.map(|m| m.is_dir()).unwrap_or(false) }
}

#[derive(Serialize)]
pub struct LocalItem {
    abs: String,
    rel: String,
    size: u64,
    dir: bool,
}

/// Guest: list what was dropped (files and folders, recursively) for upload.
/// `rel` is relative to the dropped item's parent, so folders keep their name.
#[tauri::command]
pub async fn local_walk(paths: Vec<String>) -> Result<Vec<LocalItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for p in paths {
            let p = PathBuf::from(p);
            let Some(base) = p.parent().map(Path::to_path_buf) else { continue };
            for e in walk_simple(&p) {
                let md = std::fs::symlink_metadata(&e).map_err(|x| x.to_string())?;
                if md.file_type().is_symlink() {
                    continue;
                }
                let rel = e.strip_prefix(&base).map_err(|x| x.to_string())?.to_string_lossy().replace('\\', "/");
                out.push(LocalItem {
                    abs: e.to_string_lossy().into_owned(),
                    rel,
                    size: if md.is_dir() { 0 } else { md.len() },
                    dir: md.is_dir(),
                });
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn walk_simple(p: &Path) -> Vec<PathBuf> {
    let mut out = vec![p.to_path_buf()];
    if p.is_dir() {
        if let Ok(rd) = std::fs::read_dir(p) {
            let mut kids: Vec<_> = rd.flatten().map(|e| e.path()).collect();
            kids.sort();
            for k in kids {
                let name = k.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                if k.is_dir() && is_heavy_dir(&name) {
                    continue; // never upload node_modules, .venv, .git...
                }
                out.extend(walk_simple(&k));
            }
        }
    }
    out
}

/// Guest: read part of a local file the user dropped, for upload.
#[tauri::command]
pub async fn local_read_range(path: String, offset: u64, len: u32) -> Result<Response, String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut f = tokio::fs::File::open(&path).await.map_err(|e| e.to_string())?;
    f.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(len as usize);
    f.take(len as u64).read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
    Ok(Response::new(buf))
}

/// Host: a free path for an upload (keeps the dropped name if it is free).
#[tauri::command]
pub fn fs_unique(project: State<'_, Project>, rel: String) -> Result<String, String> {
    let root = project.root()?;
    let p = unique_path(&resolve(&root, &rel)?);
    to_rel(&root, &p).ok_or_else(|| "bad path".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rejects_escapes() {
        let tmp = std::env::temp_dir().join("duet-resolve-test");
        std::fs::create_dir_all(tmp.join("a")).unwrap();
        assert!(resolve(&tmp, "a/b.txt").is_ok());
        assert!(resolve(&tmp, "./a").is_ok());
        assert!(resolve(&tmp, "../x").is_err());
        assert!(resolve(&tmp, "a/../../x").is_err());
        assert!(resolve(&tmp, "C:/Windows/x").is_err());
        assert!(resolve(&tmp, "/etc/passwd").is_err());
        assert!(resolve(&tmp, r"a\..\..\x").is_err());
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("src/o%CA%BBzbek.py").unwrap(), "src/oʻzbek.py");
        assert_eq!(percent_decode("plain").unwrap(), "plain");
    }

    #[test]
    fn unique_names() {
        let tmp = std::env::temp_dir().join("duet-unique-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("dir")).unwrap();
        std::fs::write(tmp.join("a.py"), "").unwrap();
        assert_eq!(unique_path(&tmp.join("b.py")), tmp.join("b.py"));
        assert_eq!(unique_path(&tmp.join("a.py")), tmp.join("a copy.py"));
        std::fs::write(tmp.join("a copy.py"), "").unwrap();
        assert_eq!(unique_path(&tmp.join("a.py")), tmp.join("a copy 2.py"));
        assert_eq!(unique_path(&tmp.join("dir")), tmp.join("dir copy"));
    }

    #[test]
    fn exclusions() {
        assert!(is_heavy_dir("node_modules"));
        assert!(is_secret_file(".env"));
        assert!(is_secret_file(".env.local"));
        assert!(!is_secret_file(".env.example"));
    }
}
