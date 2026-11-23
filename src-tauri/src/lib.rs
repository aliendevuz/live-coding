mod fsops;
mod kernel;
mod liveserver;
mod lsp;
mod pty;
mod sysaudio;
mod tunnel;
mod venv;

/// A folder given on the command line: what Windows passes when a folder is
/// dropped onto Duet's icon or shortcut (like "Open with Code").
#[tauri::command]
fn launch_folder() -> Option<String> {
    std::env::args_os()
        .skip(1)
        .map(std::path::PathBuf::from)
        .find(|p| p.is_dir())
        // absolute(), not canonicalize(): no `\\?\` prefix on Windows.
        .map(|p| std::path::absolute(&p).unwrap_or(p).to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // WebView2 asks the user before any page may use the microphone, like a
        // browser does. Our own page needs it for the lesson audio: grant it,
        // and only to the app's own origin (never to a page shown in a preview).
        .on_permission_request(|webview, kind| {
            use tauri::webview::{PermissionKind, PermissionResponse};
            let ours = webview
                .url()
                .map(|u| matches!(u.host_str(), Some("tauri.localhost")) || (u.host_str() == Some("localhost") && u.port() == Some(1420)))
                .unwrap_or(false);
            match kind {
                PermissionKind::Microphone if ours => PermissionResponse::Allow,
                _ => PermissionResponse::Default,
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(fsops::Project::default())
        .manage(pty::Ptys::default())
        .manage(tunnel::Tunnels::default())
        .manage(liveserver::LiveServer::default())
        .manage(lsp::Lsps::default())
        .manage(kernel::Kernels::default())
        .manage(sysaudio::SysAudio::default())
        .invoke_handler(tauri::generate_handler![
            fsops::project_open,
            fsops::fs_list,
            fsops::fs_stat,
            fsops::fs_read,
            fsops::fs_read_range,
            fsops::fs_write_text,
            fsops::fs_write_bytes,
            fsops::fs_create,
            fsops::fs_delete,
            fsops::fs_rename,
            fsops::fs_clone_list,
            fsops::local_write,
            fsops::fs_copy,
            fsops::fs_trash,
            fsops::fs_import,
            fsops::fs_unique,
            fsops::path_kind,
            fsops::local_walk,
            fsops::local_read_range,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_write_guest,
            pty::pty_guard,
            pty::pty_resize,
            pty::pty_kill,
            tunnel::tunnel_connect,
            tunnel::tunnel_listen,
            tunnel::tunnel_unlisten,
            tunnel::tunnel_attach,
            tunnel::tunnel_write,
            tunnel::tunnel_ack,
            tunnel::tunnel_close,
            tunnel::tunnel_reset,
            liveserver::live_start,
            lsp::lsp_env,
            lsp::lsp_has,
            lsp::lsp_install,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            kernel::kernel_start,
            kernel::kernel_send,
            kernel::kernel_stop,
            sysaudio::sysaudio_start,
            sysaudio::sysaudio_stop,
            launch_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Language servers are child processes: don't leave them behind.
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                lsp::stop_all(&app.state::<lsp::Lsps>());
                kernel::stop_all(&app.state::<kernel::Kernels>());
                sysaudio::stop(&app.state::<sysaudio::SysAudio>());
            }
        });
}
