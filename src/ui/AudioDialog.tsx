// Audio settings for the lesson: which microphone, and what the partner hears
// (microphone + this computer's sound), each with mute and volume.

import { useEffect, useState } from "react";
import { Headphones, Mic, MicOff, MonitorSpeaker, VolumeX, X } from "lucide-react";
import { listMics, type AudioState, type Levels } from "../core/audio";
import type { Session } from "../core/session";
import { useEvent } from "./hooks";

const ZERO: Levels = { me: 0, peer: 0, mic: 0, sys: 0 };

function Meter({ level, off }: { level: number; off?: boolean }) {
  return (
    <div className={`au-meter${off ? " off" : ""}`}>
      <div style={{ width: `${Math.round((off ? 0 : level) * 100)}%` }} />
    </div>
  );
}

function Volume({ value, max, onChange, disabled }: { value: number; max: number; onChange: (v: number) => void; disabled?: boolean }) {
  return (
    <div className="au-vol">
      <input type="range" min={0} max={max} step={0.05} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
      <span>{Math.round(value * 100)}%</span>
    </div>
  );
}

export function AudioDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const a: AudioState = useEvent(session, "audio", session.audio.state) ?? session.audio.state;
  const lv: Levels = useEvent(session, "levels", ZERO) ?? ZERO;
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const audio = session.audio;

  useEffect(() => {
    void listMics().then(setMics);
    const f = () => void listMics().then(setMics);
    navigator.mediaDevices?.addEventListener("devicechange", f);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", f);
  }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal au-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <div className="au-head">
          <b>Audio</b>
          <button className="tb-btn" onClick={onClose} title="Close (Esc)">
            <X size={15} />
          </button>
        </div>

        <section>
          <div className="au-title">
            <Mic size={14} /> Microphone
            <button className={`au-toggle${a.micMuted ? " muted" : ""}`} onClick={() => audio.setMicMuted(!a.micMuted)}>
              {a.micMuted ? <MicOff size={13} /> : <Mic size={13} />} {a.micMuted ? "Muted" : "On"}
            </button>
          </div>
          <select value={a.micId} onChange={(e) => void audio.startMic(e.target.value)}>
            <option value="">System default</option>
            {mics.map((m) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label || "Microphone"}
              </option>
            ))}
          </select>
          {!a.micOk && <div className="err">This microphone could not be opened.</div>}
          <Meter level={lv.mic} off={a.micMuted || !a.micOk} />
          <Volume value={a.micVolume} max={2} onChange={(v) => audio.setMicVolume(v)} disabled={a.micMuted} />
        </section>

        <section>
          <div className="au-title">
            <MonitorSpeaker size={14} /> System audio
            {a.sysOn ? (
              <button className={`au-toggle${a.sysMuted ? " muted" : ""}`} onClick={() => audio.setSysMuted(!a.sysMuted)}>
                {a.sysMuted ? <VolumeX size={13} /> : <MonitorSpeaker size={13} />} {a.sysMuted ? "Muted" : "On"}
              </button>
            ) : null}
          </div>
          <label className="au-check">
            <input type="checkbox" checked={a.sysOn} onChange={(e) => void audio.setSysOn(e.target.checked)} />
            Share this computer's sound (videos, music, apps)
          </label>
          <div className="dim au-note">Everything except Duet itself: {session.peer?.name ?? "your partner"}'s voice is never sent back, so there is no echo.</div>
          {a.sysError && <div className="err">{a.sysError}</div>}
          <Meter level={lv.sys} off={!a.sysOn || a.sysMuted} />
          <Volume value={a.sysVolume} max={2} onChange={(v) => audio.setSysVolume(v)} disabled={!a.sysOn || a.sysMuted} />
        </section>

        <section>
          <div className="au-title">
            <Headphones size={14} /> {session.peer?.name ?? "Partner"}'s voice
          </div>
          <Meter level={lv.peer} />
          <Volume value={a.outVolume} max={1} onChange={(v) => audio.setOutputVolume(v)} />
        </section>
      </div>
    </div>
  );
}
