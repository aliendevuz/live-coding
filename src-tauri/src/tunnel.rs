//! TCP port forwarding over the WebRTC data channel.
//!
//! Guest: `tunnel_listen(port)` opens 127.0.0.1:port locally; every accepted
//! socket is announced with a `tunnel-accept` event, and the frontend relays
//! it to the host. Host: `tunnel_connect(port)` dials 127.0.0.1:port (or ::1).
//! From there both sides look the same: bytes read from the socket go to the
//! frontend on a channel; bytes from the peer come back through `tunnel_write`.
//!
//! Flow control: the reader takes one credit per chunk and the frontend returns
//! credits (`tunnel_ack`) once a chunk has actually left over WebRTC, so a fast
//! local server cannot flood memory while the link is slow.

use crate::fsops::{header, raw_body};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody, Request};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Semaphore};
use tauri::async_runtime::JoinHandle;
use tauri::Manager;

const CHUNK: usize = 16 * 1024;
const CREDITS: usize = 32; // 32 x 16 KiB = 512 KiB in flight per connection

struct Conn {
    tx: mpsc::UnboundedSender<Vec<u8>>,
    credits: Arc<Semaphore>,
    tasks: Vec<JoinHandle<()>>,
}

#[derive(Default)]
pub struct Tunnels {
    next: AtomicU32,
    conns: Arc<Mutex<HashMap<u32, Conn>>>,
    /// Guest: accepted sockets waiting for `tunnel_attach`.
    pending: Mutex<HashMap<u32, TcpStream>>,
    /// Guest: listening sockets by the host port they forward.
    listeners: Mutex<HashMap<u16, JoinHandle<()>>>,
}

#[derive(Serialize, Clone)]
struct Accept {
    id: u32,
    /// Host port this connection should reach.
    port: u16,
}

#[derive(Serialize, Clone)]
struct Closed {
    id: u32,
}

fn start(app: AppHandle, t: &Tunnels, id: u32, stream: TcpStream, on_data: Channel<InvokeResponseBody>) {
    let _ = stream.set_nodelay(true);
    let (mut rd, mut wr) = stream.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let credits = Arc::new(Semaphore::new(CREDITS));

    let c = credits.clone();
    let conns = t.conns.clone();
    let reader = tauri::async_runtime::spawn(async move {
        let mut buf = vec![0u8; CHUNK];
        loop {
            let Ok(permit) = c.acquire().await else { break };
            permit.forget();
            match rd.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
        // Local side finished: tell the frontend so it closes the remote end.
        if conns.lock().unwrap().contains_key(&id) {
            let _ = app.emit("tunnel-closed", Closed { id });
        }
    });
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            if wr.write_all(&chunk).await.is_err() {
                break;
            }
        }
        let _ = wr.shutdown().await;
    });
    let tasks = vec![reader, writer];
    t.conns.lock().unwrap().insert(id, Conn { tx, credits, tasks });
}

/// Host: dial a local port that the host chose to share.
#[tauri::command]
pub async fn tunnel_connect(
    app: AppHandle,
    t: State<'_, Tunnels>,
    port: u16,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let stream = match TcpStream::connect(("127.0.0.1", port)).await {
        Ok(s) => s,
        Err(_) => TcpStream::connect(("::1", port)).await.map_err(|e| format!("localhost:{port}: {e}"))?,
    };
    let id = t.next.fetch_add(1, Ordering::Relaxed) + 1;
    start(app, &t, id, stream, on_data);
    Ok(id)
}

/// Guest: listen locally for a forwarded host port. Returns the local port
/// (the same number when free, otherwise a random one).
#[tauri::command]
pub async fn tunnel_listen(app: AppHandle, t: State<'_, Tunnels>, port: u16) -> Result<u16, String> {
    if let Some(old) = t.listeners.lock().unwrap().remove(&port) {
        old.abort();
    }
    let listener = match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?,
    };
    let local = listener.local_addr().map_err(|e| e.to_string())?.port();
    let app2 = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let t = app2.state::<Tunnels>();
            let id = t.next.fetch_add(1, Ordering::Relaxed) + 1;
            t.pending.lock().unwrap().insert(id, stream);
            let _ = app2.emit("tunnel-accept", Accept { id, port });
        }
    });
    t.listeners.lock().unwrap().insert(port, task);
    Ok(local)
}

#[tauri::command]
pub fn tunnel_unlisten(t: State<'_, Tunnels>, port: u16) {
    if let Some(h) = t.listeners.lock().unwrap().remove(&port) {
        h.abort();
    }
}

/// Guest: start pumping an accepted socket once the host side is ready.
#[tauri::command]
pub fn tunnel_attach(
    app: AppHandle,
    t: State<'_, Tunnels>,
    id: u32,
    on_data: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let stream = t.pending.lock().unwrap().remove(&id).ok_or("no such pending connection")?;
    start(app, &t, id, stream, on_data);
    Ok(())
}

/// Bytes from the peer, raw body; connection id in `x-id`.
#[tauri::command]
pub fn tunnel_write(t: State<'_, Tunnels>, request: Request<'_>) -> Result<(), String> {
    let id: u32 = header(&request, "x-id")?.parse().map_err(|_| "bad id")?;
    let bytes = raw_body(&request)?.to_vec();
    let conns = t.conns.lock().unwrap();
    let c = conns.get(&id).ok_or("closed")?;
    c.tx.send(bytes).map_err(|_| "closed".to_string())
}

#[tauri::command]
pub fn tunnel_ack(t: State<'_, Tunnels>, id: u32, n: u32) {
    if let Some(c) = t.conns.lock().unwrap().get(&id) {
        c.credits.add_permits(n as usize);
    }
}

#[tauri::command]
pub fn tunnel_close(t: State<'_, Tunnels>, id: u32) {
    t.pending.lock().unwrap().remove(&id);
    if let Some(c) = t.conns.lock().unwrap().remove(&id) {
        // Reader stops now; writer drains what is queued, then shuts down.
        c.tasks[0].abort();
        drop(c.tx);
    }
}

/// Drop every connection and listener (session ended or reconnecting).
#[tauri::command]
pub fn tunnel_reset(t: State<'_, Tunnels>) {
    for (_, c) in t.conns.lock().unwrap().drain() {
        for h in c.tasks {
            h.abort();
        }
    }
    t.pending.lock().unwrap().clear();
    for (_, h) in t.listeners.lock().unwrap().drain() {
        h.abort();
    }
}
