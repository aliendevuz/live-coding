mod fsops;
mod kernel;
mod lsp;
mod pty;
mod tunnel;
mod venv;

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
        .manage(lsp::Lsps::default())
        .manage(kernel::Kernels::default())
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
            lsp::lsp_env,
            lsp::lsp_has,
            lsp::lsp_install,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            kernel::kernel_start,
            kernel::kernel_send,
            kernel::kernel_stop,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Language servers are child processes: don't leave them behind.
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                lsp::stop_all(&app.state::<lsp::Lsps>());
                kernel::stop_all(&app.state::<kernel::Kernels>());
            }
        });
}
