//! Real terminals on the host (ConPTY via portable-pty). Output goes to the
//! frontend as raw bytes over a Tauri channel; the frontend renders it in
//! xterm.js and mirrors it to the guest.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

/// Loaded into every PowerShell terminal: while the student may type, commands
/// must stay inside the project folder (see the script's header).
const GUARD_PS1: &str = include_str!("../resources/duet_guard.ps1");
/// Printed by the guard once it is active.
const GUARD_READY: &[u8] = b"\x1b]633;DuetGuard\x07";

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    /// The guard is active in this shell; only then may the student type in it.
    guarded: Arc<AtomicBool>,
}

/// Exists while the host lets the student type (the guard script checks it).
pub fn guard_flag() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("duet-guard-{}.on", std::process::id()))
}

#[tauri::command]
pub fn pty_guard(on: bool) -> Result<(), String> {
    let f = guard_flag();
    if on {
        std::fs::write(&f, b"1").map_err(|e| e.to_string())
    } else {
        match std::fs::remove_file(&f) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

/// UTF-16LE + base64, as PowerShell's -EncodedCommand expects.
fn encode_command(script: &str) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let mut out = String::with_capacity(bytes.len() * 4 / 3 + 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[derive(Default)]
pub struct Ptys {
    next: AtomicU32,
    map: Arc<Mutex<HashMap<u32, Session>>>,
}

#[derive(Serialize, Clone)]
struct PtyExit {
    id: u32,
    code: Option<u32>,
}

/// The shell, and whether it is PowerShell (the guard needs PSReadLine).
#[cfg(not(windows))]
fn default_shell() -> (CommandBuilder, bool) {
    // The user's login shell (zsh on macOS), as an interactive login shell.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut c = CommandBuilder::new(shell);
    c.arg("-l");
    (c, false)
}

#[cfg(windows)]
fn default_shell() -> (CommandBuilder, bool) {
    // Prefer PowerShell 7, then Windows PowerShell, then cmd.
    for (exe, args) in [("pwsh.exe", &["-NoLogo"][..]), ("powershell.exe", &["-NoLogo"][..])] {
        if which(exe) {
            let mut c = CommandBuilder::new(exe);
            c.args(args);
            return (c, true);
        }
    }
    (CommandBuilder::new(std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())), false)
}

#[cfg(windows)]
fn which(exe: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(exe).is_file()))
        .unwrap_or(false)
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    ptys: State<'_, Ptys>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let (mut cmd, powershell) = default_shell();
    if powershell {
        if let Ok(root) = app.state::<crate::fsops::Project>().root() {
            cmd.args(["-NoExit", "-EncodedCommand", &encode_command(GUARD_PS1)]);
            cmd.env("DUET_ROOT", root);
            cmd.env("DUET_GUARD_FLAG", guard_flag());
        }
    }
    if let Some(dir) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
        // Terminals in a project with a venv start "activated", like VS Code's.
        if let Some(venv) = crate::venv::find_in(std::path::Path::new(&dir)) {
            let (key, path, ve) = crate::venv::activation(&venv);
            cmd.env(key, path);
            cmd.env("VIRTUAL_ENV", ve);
        }
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("PYTHONUNBUFFERED", "1"); // so print() shows up immediately
    cmd.env("FORCE_COLOR", "1");
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = ptys.next.fetch_add(1, Ordering::Relaxed) + 1;
    let guarded = Arc::new(AtomicBool::new(false));
    ptys.map.lock().unwrap().insert(
        id,
        Session { master: pair.master, writer, killer: child.clone_killer(), guarded: guarded.clone() },
    );

    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        // Watch for the guard's ready marker (it may straddle two reads).
        let mut tail: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if !guarded.load(Ordering::Relaxed) {
                        tail.extend_from_slice(&buf[..n]);
                        if tail.windows(GUARD_READY.len()).any(|w| w == GUARD_READY) {
                            guarded.store(true, Ordering::Relaxed);
                            tail = Vec::new();
                        } else if tail.len() > GUARD_READY.len() {
                            tail.drain(..tail.len() - GUARD_READY.len());
                        }
                    }
                    if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let map = ptys.map.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        // Dropping the master closes ConPTY, which ends the reader thread.
        map.lock().unwrap().remove(&id);
        let _ = app.emit("pty-exit", PtyExit { id, code });
    });
    Ok(id)
}

#[tauri::command]
pub fn pty_write(ptys: State<'_, Ptys>, id: u32, data: String) -> Result<(), String> {
    let mut map = ptys.map.lock().unwrap();
    let s = map.get_mut(&id).ok_or("no such terminal")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

/// Input typed by the student: only into a shell whose guard is active.
#[tauri::command]
pub fn pty_write_guest(ptys: State<'_, Ptys>, id: u32, data: String) -> Result<(), String> {
    let mut map = ptys.map.lock().unwrap();
    let s = map.get_mut(&id).ok_or("no such terminal")?;
    if !s.guarded.load(Ordering::Relaxed) {
        return Err("this terminal has no folder guard (PowerShell with PSReadLine is needed), so the student cannot type in it".into());
    }
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(ptys: State<'_, Ptys>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = ptys.map.lock().unwrap();
    let s = map.get(&id).ok_or("no such terminal")?;
    s.master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(ptys: State<'_, Ptys>, id: u32) -> Result<(), String> {
    let mut map = ptys.map.lock().unwrap();
    if let Some(s) = map.get_mut(&id) {
        let _ = s.killer.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::encode_command;

    #[test]
    fn encodes_like_powershell() {
        // [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("dir"))
        assert_eq!(encode_command("dir"), "ZABpAHIA");
        assert_eq!(encode_command("ab"), "YQBiAA==");
    }
}
