//! Language servers (Pyright, typescript-language-server) on the host.
//!
//! Servers are npm packages installed once into the app's local data folder
//! and started with the system `node`. Messages are JSON-RPC framed with
//! `Content-Length` headers over stdio; complete JSON bodies go to the
//! frontend over a channel.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

struct Server {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct Lsps {
    map: Arc<Mutex<HashMap<String, Server>>>,
}

#[derive(Serialize, Clone)]
struct LspExit {
    id: String,
}

#[derive(Serialize)]
pub struct LspEnv {
    /// Folder the servers are installed into.
    dir: String,
    /// `node` executable, if found.
    node: Option<String>,
}

fn which(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(exe)).find(|p| p.is_file())
}

fn tools_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("lsp");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

#[tauri::command]
pub fn lsp_env(app: AppHandle) -> Result<LspEnv, String> {
    Ok(LspEnv {
        dir: tools_dir(&app)?.to_string_lossy().replace('\\', "/"),
        node: which("node.exe").or_else(|| which("node")).map(|p| p.to_string_lossy().into_owned()),
    })
}

/// True if `rel` exists under the tools folder (an installed server entry point).
#[tauri::command]
pub fn lsp_has(app: AppHandle, rel: String) -> Result<bool, String> {
    if rel.contains("..") {
        return Err("bad path".into());
    }
    Ok(tools_dir(&app)?.join(rel).is_file())
}

/// `npm install` the given packages into the tools folder (one time setup).
#[tauri::command]
pub async fn lsp_install(app: AppHandle, packages: Vec<String>) -> Result<(), String> {
    for p in &packages {
        // Package names only (optionally @scope/ and @version): never options or paths.
        if !p.chars().all(|c| c.is_ascii_alphanumeric() || "@/._-^~".contains(c)) || p.starts_with('-') {
            return Err(format!("bad package name: {p}"));
        }
    }
    let dir = tools_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !dir.join("package.json").is_file() {
            std::fs::write(dir.join("package.json"), "{\"name\":\"duet-lsp\",\"private\":true}\n").map_err(|e| e.to_string())?;
        }
        // npm is a .cmd script on Windows, a plain executable elsewhere.
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/d", "/c", "npm"]);
            c
        } else {
            Command::new("npm")
        };
        cmd.args(["install", "--no-audit", "--no-fund", "--loglevel=error"])
            .args(&packages)
            .current_dir(&dir)
            .stdin(Stdio::null());
        let out = quiet(&mut cmd).output().map_err(|e| format!("npm: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(format!("npm install failed: {}", err.chars().rev().take(600).collect::<String>().chars().rev().collect::<String>()))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Start `node <tools>/<entry> <args>` in `cwd`. Each complete JSON message
/// from the server is sent on `on_msg` as raw UTF-8 bytes.
#[tauri::command]
pub fn lsp_start(
    app: AppHandle,
    lsps: State<'_, Lsps>,
    id: String,
    node: String,
    entry: String,
    args: Vec<String>,
    cwd: String,
    on_msg: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    if entry.contains("..") {
        return Err("bad entry".into());
    }
    if let Some(mut old) = lsps.map.lock().unwrap().remove(&id) {
        let _ = old.child.kill();
    }
    let script = tools_dir(&app)?.join(&entry);
    let mut cmd = Command::new(&node);
    cmd.arg(&script)
        .args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = quiet(&mut cmd).spawn().map_err(|e| format!("{}: {e}", script.display()))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    lsps.map.lock().unwrap().insert(id.clone(), Server { child, stdin });

    // stderr: servers log there; drain it so the pipe never fills up.
    std::thread::spawn(move || {
        let mut sink = Vec::new();
        let _ = BufReader::new(stderr).read_to_end(&mut sink);
    });

    let map = lsps.map.clone();
    std::thread::spawn(move || {
        let mut r = BufReader::new(stdout);
        loop {
            // Header block: lines until an empty one; we need Content-Length.
            let mut len: Option<usize> = None;
            let mut line = String::new();
            loop {
                line.clear();
                match r.read_line(&mut line) {
                    Ok(0) | Err(_) => {
                        map.lock().unwrap().remove(&id);
                        let _ = app.emit("lsp-exit", LspExit { id });
                        return;
                    }
                    Ok(_) => {}
                }
                let l = line.trim_end();
                if l.is_empty() {
                    break;
                }
                if let Some(v) = l.strip_prefix("Content-Length:") {
                    len = v.trim().parse().ok();
                }
            }
            let Some(n) = len else { continue };
            let mut body = vec![0u8; n];
            if r.read_exact(&mut body).is_err() {
                continue;
            }
            if on_msg.send(InvokeResponseBody::Raw(body)).is_err() {
                return;
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn lsp_send(lsps: State<'_, Lsps>, id: String, msg: String) -> Result<(), String> {
    let mut map = lsps.map.lock().unwrap();
    let s = map.get_mut(&id).ok_or("server not running")?;
    write!(s.stdin, "Content-Length: {}\r\n\r\n", msg.len()).map_err(|e| e.to_string())?;
    s.stdin.write_all(msg.as_bytes()).map_err(|e| e.to_string())?;
    s.stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lsp_stop(lsps: State<'_, Lsps>, id: String) {
    if let Some(mut s) = lsps.map.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
}

/// Kill every server (app exit / session end).
pub fn stop_all(lsps: &Lsps) {
    for (_, mut s) in lsps.map.lock().unwrap().drain() {
        let _ = s.child.kill();
    }
}
