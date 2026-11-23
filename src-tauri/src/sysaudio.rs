// System audio for the lesson: everything the computer plays EXCEPT this app.
//
// Windows 10 2004+ can capture "all processes but one process tree" (WASAPI
// process loopback, EXCLUDE_TARGET_PROCESS_TREE). Our WebView2 processes are
// children of this process, so the partner's voice that we play back is never
// captured: no echo loop, no howling speakers. Samples go to the page as mono
// float32 at 48 kHz, ~10 ms per message, and are mixed with the microphone there.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

#[derive(Default)]
pub struct SysAudio {
    current: Mutex<Option<(u64, Arc<AtomicBool>)>>,
    next: AtomicU64,
}

pub const RATE: u32 = 48_000;

#[tauri::command]
pub fn sysaudio_start(state: State<'_, SysAudio>, on_data: Channel<InvokeResponseBody>) -> Result<u64, String> {
    stop(&state);
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let stop_flag = Arc::new(AtomicBool::new(false));
    *state.current.lock().unwrap() = Some((id, stop_flag.clone()));
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
    std::thread::Builder::new()
        .name("sysaudio".into())
        .spawn(move || capture(on_data, stop_flag, tx))
        .map_err(|e| e.to_string())?;
    // Report a failed start (old Windows, no audio service) to the caller.
    match rx.recv() {
        Ok(Ok(())) => Ok(id),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("system audio capture ended".into()),
    }
}

#[tauri::command]
pub fn sysaudio_stop(state: State<'_, SysAudio>) {
    stop(&state);
}

pub fn stop(state: &SysAudio) {
    if let Some((_, flag)) = state.current.lock().unwrap().take() {
        flag.store(true, Ordering::Relaxed);
    }
}

#[cfg(windows)]
fn capture(out: Channel<InvokeResponseBody>, stop: Arc<AtomicBool>, ready: std::sync::mpsc::SyncSender<Result<(), String>>) {
    use std::collections::VecDeque;
    use wasapi::*;

    let setup = || -> Result<(AudioClient, AudioCaptureClient, Handle), String> {
        let _ = initialize_mta();
        let fmt = WaveFormat::new(32, 32, SampleType::Float, RATE as usize, 2, None);
        // Exclude our own process tree (the WebView that plays the partner's voice).
        let mut client = AudioClient::new_application_loopback_client(std::process::id(), false)
            .map_err(|e| format!("system audio capture needs Windows 10 (2004) or newer: {e}"))?;
        client
            .initialize_client(&fmt, Direction::Capture, StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 }, None)
            .map_err(|e| e.to_string())?;
        let ev = client.set_get_eventhandle().map_err(|e| e.to_string())?;
        let cap = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
        client.start_stream().map_err(|e| e.to_string())?;
        Ok((client, cap, ev))
    };
    let (client, cap, ev) = match setup() {
        Ok(v) => {
            let _ = ready.send(Ok(()));
            v
        }
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };

    const FRAME: usize = 8; // stereo f32
    const CHUNK: usize = (RATE as usize / 100) * FRAME; // 10 ms
    let mut q: VecDeque<u8> = VecDeque::with_capacity(CHUNK * 8);
    while !stop.load(Ordering::Relaxed) {
        // Nothing playing means no packets: just wait again.
        let _ = ev.wait_for_event(100);
        loop {
            match cap.get_next_packet_size() {
                Ok(Some(n)) if n > 0 => {
                    if cap.read_from_device_to_deque(&mut q).is_err() {
                        break;
                    }
                }
                Ok(_) => break,
                Err(_) => {
                    let _ = client.stop_stream();
                    return;
                }
            }
        }
        while q.len() >= CHUNK {
            let mut mono = Vec::with_capacity(CHUNK / 2);
            for _ in 0..CHUNK / FRAME {
                let mut b = [0u8; 8];
                for x in b.iter_mut() {
                    *x = q.pop_front().unwrap();
                }
                let l = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                let r = f32::from_le_bytes([b[4], b[5], b[6], b[7]]);
                mono.extend_from_slice(&((l + r) * 0.5).to_le_bytes());
            }
            if out.send(InvokeResponseBody::Raw(mono)).is_err() {
                let _ = client.stop_stream();
                return;
            }
        }
    }
    let _ = client.stop_stream();
}

#[cfg(not(windows))]
fn capture(_out: Channel<InvokeResponseBody>, _stop: Arc<AtomicBool>, ready: std::sync::mpsc::SyncSender<Result<(), String>>) {
    let _ = ready.send(Err("System audio capture is only available on Windows.".into()));
}
