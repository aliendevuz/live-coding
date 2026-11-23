//! Live server for HTML lessons (replaces `python -m http.server`).
//!
//! Serves the open project on 127.0.0.1 and injects a tiny client
//! (`/__duet/live.js`) into every HTML page. The client listens on
//! `/__duet/events` (Server-Sent Events) and, when the project watcher reports
//! a change, updates the page in place: stylesheets and images are swapped,
//! the HTML is re-fetched and only the nodes that changed are patched. A full
//! reload happens only when the page's own scripts changed. The guest reaches
//! the same server through the shared port, so both screens update together.

use crate::fsops::{is_secret_file, resolve, Project};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;

const CLIENT_JS: &str = include_str!("../resources/duet_live.js");
const INJECT: &str = "<script id=\"__duet_live\" src=\"/__duet/live.js\"></script>";

pub struct LiveServer {
    port: Mutex<Option<u16>>,
    tx: broadcast::Sender<String>,
}

impl Default for LiveServer {
    fn default() -> Self {
        Self { port: Mutex::new(None), tx: broadcast::channel(64).0 }
    }
}

impl LiveServer {
    /// Called by the project watcher with changed project-relative paths.
    pub fn changed(&self, paths: &[String]) {
        if self.port.lock().unwrap().is_none() || paths.is_empty() {
            return;
        }
        if let Ok(json) = serde_json::to_string(paths) {
            let _ = self.tx.send(json);
        }
    }
}

/// Start (once) and return the port. Tries `port`, then any free port.
#[tauri::command]
pub async fn live_start(app: AppHandle, live: State<'_, LiveServer>, port: u16) -> Result<u16, String> {
    if let Some(p) = *live.port.lock().unwrap() {
        return Ok(p);
    }
    let listener = match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?,
    };
    let bound = listener.local_addr().map_err(|e| e.to_string())?.port();
    *live.port.lock().unwrap() = Some(bound);
    tauri::async_runtime::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = serve(app, sock).await;
            });
        }
    });
    Ok(bound)
}

async fn serve(app: AppHandle, mut sock: TcpStream) -> std::io::Result<()> {
    // Read the request head (we only need the request line).
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    loop {
        let n = sock.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 32 * 1024 {
            return respond(&mut sock, 431, "text/plain", b"request too large", false).await;
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let mut parts = head.lines().next().unwrap_or("").split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");
    let head_only = method == "HEAD";
    if method != "GET" && !head_only {
        return respond(&mut sock, 405, "text/plain", b"method not allowed", false).await;
    }
    let path = percent_decode(target.split(['?', '#']).next().unwrap_or("/"));

    if path == "/__duet/live.js" {
        return respond(&mut sock, 200, "text/javascript; charset=utf-8", CLIENT_JS.as_bytes(), head_only).await;
    }
    if path == "/__duet/events" {
        return events(&app, sock).await;
    }

    let project = app.state::<Project>();
    let Ok(root) = project.root() else {
        return respond(&mut sock, 503, "text/plain", b"no project open", head_only).await;
    };
    let rel = path.trim_start_matches('/').to_string();
    if rel.split('/').any(|seg| is_secret_file(seg)) {
        return respond(&mut sock, 404, "text/plain", b"not found", head_only).await;
    }
    let Ok(mut abs) = resolve(&root, &rel) else {
        return respond(&mut sock, 404, "text/plain", b"not found", head_only).await;
    };
    if abs.is_dir() {
        if !path.ends_with('/') {
            // Relative links inside index.html need the trailing slash.
            let loc = format!("{path}/");
            let msg = format!(
                "HTTP/1.1 301 Moved Permanently\r\nLocation: {loc}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            return sock.write_all(msg.as_bytes()).await;
        }
        let index = abs.join("index.html");
        if index.is_file() {
            abs = index;
        } else {
            let body = listing(&abs, &path);
            return respond(&mut sock, 200, "text/html; charset=utf-8", body.as_bytes(), head_only).await;
        }
    }
    let Ok(bytes) = tokio::fs::read(&abs).await else {
        return respond(&mut sock, 404, "text/plain", b"not found", head_only).await;
    };
    let ext = abs.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = mime_of(&ext);
    if ext == "html" || ext == "htm" {
        let html = inject(&String::from_utf8_lossy(&bytes));
        return respond(&mut sock, 200, mime, html.as_bytes(), head_only).await;
    }
    respond(&mut sock, 200, mime, &bytes, head_only).await
}

/// Server-Sent Events: one `data:` line per batch of changed paths.
async fn events(app: &AppHandle, mut sock: TcpStream) -> std::io::Result<()> {
    let mut rx = app.state::<LiveServer>().tx.subscribe();
    sock.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\n\r\nretry: 1000\n\n",
    )
    .await?;
    loop {
        let msg = tokio::select! {
            r = rx.recv() => match r {
                Ok(json) => format!("data: {json}\n\n"),
                Err(broadcast::error::RecvError::Lagged(_)) => "data: [\"*\"]\n\n".to_string(),
                Err(_) => return Ok(()),
            },
            _ = tokio::time::sleep(Duration::from_secs(15)) => ": ping\n\n".to_string(),
        };
        sock.write_all(msg.as_bytes()).await?;
    }
}

async fn respond(sock: &mut TcpStream, status: u16, mime: &str, body: &[u8], head_only: bool) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        405 => "Method Not Allowed",
        431 => "Request Header Fields Too Large",
        _ => "Service Unavailable",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    sock.write_all(head.as_bytes()).await?;
    if !head_only {
        sock.write_all(body).await?;
    }
    sock.flush().await
}

/// Put the live client just before `</body>` (or at the end).
fn inject(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    match lower.rfind("</body>") {
        Some(i) => format!("{}{INJECT}{}", &html[..i], &html[i..]),
        None => format!("{html}{INJECT}"),
    }
}

fn listing(dir: &Path, url: &str) -> String {
    let mut names: Vec<(bool, String)> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    if is_secret_file(&name) {
                        return None;
                    }
                    Some((e.path().is_dir(), name))
                })
                .collect()
        })
        .unwrap_or_default();
    names.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.to_lowercase().cmp(&b.1.to_lowercase())));
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('"', "&quot;");
    let items: String = names
        .iter()
        .map(|(d, n)| {
            let slash = if *d { "/" } else { "" };
            format!("<li><a href=\"{}{slash}\">{}{slash}</a></li>", esc(&percent_encode(n)), esc(n))
        })
        .collect();
    inject(&format!(
        "<!DOCTYPE html><meta charset=\"utf-8\"><title>{0}</title><body style=\"font:14px system-ui;padding:16px\"><h3>{0}</h3><ul>{items}</ul></body>",
        esc(url)
    ))
}

fn mime_of(ext: &str) -> &'static str {
    match ext {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "pdf" => "application/pdf",
        "xml" => "application/xml",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|c| match c {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (c as char).to_string(),
            _ => format!("%{c:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_before_body_end() {
        assert_eq!(inject("<p>x</p></BODY></html>"), format!("<p>x</p>{INJECT}</BODY></html>"));
        assert_eq!(inject("<p>x</p>"), format!("<p>x</p>{INJECT}"));
    }

    #[test]
    fn decodes_paths() {
        assert_eq!(percent_decode("/my%20page.html"), "/my page.html");
        assert_eq!(percent_decode("/a%2"), "/a%2");
        assert_eq!(percent_decode("/%D0%B0"), "/а");
    }
}
