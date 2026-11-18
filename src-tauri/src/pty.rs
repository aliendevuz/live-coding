//! Real terminals on the host (ConPTY via portable-pty). Output goes to the
//! frontend as raw bytes over a Tauri channel; the frontend renders it in
//! xterm.js and mirrors it to the guest.

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
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

#[cfg(not(windows))]
fn default_shell() -> CommandBuilder {
    // The user's login shell (zsh on macOS), as an interactive login shell.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut c = CommandBuilder::new(shell);
    c.arg("-l");
    c
}

#[cfg(windows)]
fn default_shell() -> CommandBuilder {
    // Prefer PowerShell 7, then Windows PowerShell, then cmd.
    for (exe, args) in [("pwsh.exe", &["-NoLogo"][..]), ("powershell.exe", &["-NoLogo"][..])] {
        if which(exe) {
            let mut c = CommandBuilder::new(exe);
            c.args(args);
            return c;
        }
    }
    CommandBuilder::new(std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()))
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
    let mut cmd = default_shell();
    if let Some(dir) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
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
    ptys.map.lock().unwrap().insert(
        id,
        Session { master: pair.master, writer, killer: child.clone_killer() },
    );

    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
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
