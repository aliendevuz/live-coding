//! Jupyter kernels for notebooks, on the host.
//!
//! Each notebook gets a bridge process (`python -u duet_kernel.py`) that runs a
//! real ipykernel through jupyter_client and speaks JSON lines on stdio. The
//! bridge script ships inside the app and is written to the app data folder.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const BRIDGE: &str = include_str!("../resources/duet_kernel.py");

struct Kernel {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct Kernels {
    map: Arc<Mutex<HashMap<String, Kernel>>>,
}

#[derive(serde::Serialize, Clone)]
struct KernelExit {
    id: String,
}

fn bridge_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("kernel");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = dir.join("duet_kernel.py");
    // Always rewrite: keeps the bridge in step with the installed app version.
    std::fs::write(&p, BRIDGE).map_err(|e| e.to_string())?;
    Ok(p)
}

/// Start a kernel bridge for a notebook. Lines from the bridge (JSON) go to `on_msg`.
#[tauri::command]
pub fn kernel_start(
    app: AppHandle,
    kernels: State<'_, Kernels>,
    id: String,
    python: String,
    cwd: String,
    on_msg: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    if let Some(mut old) = kernels.map.lock().unwrap().remove(&id) {
        let _ = old.child.kill();
    }
    let script = bridge_path(&app)?;
    let mut cmd = Command::new(&python);
    cmd.arg("-u")
        .arg(&script)
        .current_dir(&cwd)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The kernel inherits this environment: with the venv first on PATH,
    // `!pip install x` in a cell installs into the kernel's own Python.
    if let Some(venv) = crate::venv::of_python(&python) {
        let (key, path, ve) = crate::venv::activation(&venv);
        cmd.env(key, path).env("VIRTUAL_ENV", ve);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|e| format!("Could not start {python}: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    kernels.map.lock().unwrap().insert(id.clone(), Kernel { child, stdin });

    std::thread::spawn(move || {
        let mut sink = Vec::new();
        let _ = BufReader::new(stderr).read_to_end(&mut sink);
    });
    let map = kernels.map.clone();
    std::thread::spawn(move || {
        let mut r = BufReader::new(stdout);
        let mut line = Vec::new();
        loop {
            line.clear();
            match r.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    while matches!(line.last(), Some(b'\n' | b'\r')) {
                        line.pop();
                    }
                    if !line.is_empty() && on_msg.send(InvokeResponseBody::Raw(line.clone())).is_err() {
                        break;
                    }
                }
            }
        }
        map.lock().unwrap().remove(&id);
        let _ = app.emit("kernel-exit", KernelExit { id });
    });
    Ok(())
}

#[tauri::command]
pub fn kernel_send(kernels: State<'_, Kernels>, id: String, msg: String) -> Result<(), String> {
    let mut map = kernels.map.lock().unwrap();
    let k = map.get_mut(&id).ok_or("kernel not running")?;
    k.stdin.write_all(msg.as_bytes()).map_err(|e| e.to_string())?;
    k.stdin.write_all(b"\n").map_err(|e| e.to_string())?;
    k.stdin.flush().map_err(|e| e.to_string())
}

/// Ask the bridge to shut its kernel down; kill it if it does not exit soon.
#[tauri::command]
pub fn kernel_stop(kernels: State<'_, Kernels>, id: String) {
    let Some(mut k) = kernels.map.lock().unwrap().remove(&id) else { return };
    let _ = k.stdin.write_all(b"{\"op\":\"shutdown\"}\n");
    let _ = k.stdin.flush();
    drop(k.stdin);
    std::thread::spawn(move || {
        for _ in 0..30 {
            if matches!(k.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let _ = k.child.kill();
    });
}

pub fn stop_all(kernels: &Kernels) {
    for (_, mut k) in kernels.map.lock().unwrap().drain() {
        // Closing stdin makes the bridge shut its kernel down cleanly.
        let _ = k.stdin.write_all(b"{\"op\":\"shutdown\"}\n");
        let _ = k.stdin.flush();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let _ = k.child.kill();
    }
}
