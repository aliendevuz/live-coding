import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, ChevronRight, FolderOpen, GraduationCap, History, LogIn, Mic, Settings2, UserRound, Users } from "lucide-react";
import { listMics } from "../core/audio";
import { Logo } from "./icons";
import { invoke } from "@tauri-apps/api/core";
import { useFileDrop } from "./useFileDrop";
import { Session } from "../core/session";
import { loadHostedRoom, saveHostedRoom, saveSettings, type Settings } from "../core/settings";
import { randomString } from "../core/util";
import { askText } from "./prompt";

interface Props {
  settings: Settings;
  onSettings: (s: Settings) => void;
  onSession: (s: Session) => void;
}

/** Room codes: 10 characters, shown as xxxxx-xxxxx. */
const newRoom = () => randomString(10);
export const prettyRoom = (r: string) => `${r.slice(0, 5)}-${r.slice(5)}`;
const cleanRoom = (r: string) => r.toLowerCase().replace(/[^a-z0-9]/g, "");

export function Lobby({ settings, onSettings, onSession }: Props) {
  const [s, setS] = useState(settings);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [showAdv, setShowAdv] = useState(!settings.signalingUrl || settings.signalingUrl.includes("localhost"));
  const hosted = loadHostedRoom();

  useEffect(() => {
    // Ask once for mic access so device labels are visible.
    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((st) => st.getTracks().forEach((t) => t.stop()))
      .catch(() => {})
      .finally(() => void listMics().then(setMics));
  }, []);

  const update = (patch: Partial<Settings>) => {
    const next = { ...s, ...patch };
    setS(next);
    saveSettings(next);
    onSettings(next);
  };

  const guard = async (fn: (cur: Settings) => Promise<void>) => {
    setErr("");
    let cur = s;
    // Opened by dropping a folder (on the window or on the app icon) before a
    // name was ever entered: ask for it now instead of failing.
    if (!cur.name.trim()) {
      const name = await askText("Your name (your partner will see it)");
      if (!name) return setErr("Enter your name first.");
      cur = { ...cur, name };
      update({ name });
    }
    if (!/^https?:\/\//.test(cur.signalingUrl)) return setErr("Set the signaling URL (Advanced).");
    setBusy(true);
    try {
      await fn(cur);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const host = (reuse: boolean, dropped?: string) =>
    guard(async (cur) => {
      let project = dropped ?? (reuse && hosted ? hosted.project : null);
      if (!project) {
        const picked = await openDialog({ directory: true, title: "Choose the project folder to teach from" });
        if (!picked || Array.isArray(picked)) return;
        project = picked;
      }
      // Dropping the same folder again reopens the same room, so students can rejoin.
      const same = hosted && (reuse || hosted.project === project);
      const room = same ? hosted.room : newRoom();
      const key = same ? hosted.key : randomString(32, "0123456789abcdef");
      saveHostedRoom({ room, key, project });
      onSession(await Session.host(cur, project, room, key));
    });

  const join = () =>
    guard(async (cur) => {
      const room = cleanRoom(code);
      if (room.length < 8) throw new Error("Enter the room code you got from the host.");
      onSession(await Session.join(cur, room));
    });

  // A folder dropped onto Duet's icon or shortcut arrives on the command line
  // (like VS Code): host it right away. Once per app start, not after Leave.
  useEffect(() => {
    if (sessionStorage.getItem("duet.launchFolder")) return;
    sessionStorage.setItem("duet.launchFolder", "1");
    void invoke<string | null>("launch_folder").then((dir) => {
      if (dir) void host(false, dir);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drop a project folder anywhere on the window to start teaching from it.
  const dragging = useFileDrop((paths) => {
    void (async () => {
      const kind = await invoke<{ exists: boolean; dir: boolean }>("path_kind", { path: paths[0] });
      if (!kind.dir) return setErr("Drop a folder (your project), not a single file.");
      await host(false, paths[0]);
    })();
  }, !busy);

  return (
    <div className="lobby">
      {dragging && (
        <div className="drop-zone">
          <div>
            <FolderOpen size={22} color="#3aaaff" /> Drop the project folder to start a lesson
          </div>
        </div>
      )}
      <div className="lobby-card">
        <div className="lobby-head">
          <Logo size={40} />
          <div>
            <h1>Duet</h1>
            <div className="dim">Code together, live — peer to peer</div>
          </div>
        </div>
        <label>
          <span className="label-row">
            <UserRound size={13} /> Your name
          </span>
          <input value={s.name} onChange={(e) => update({ name: e.target.value })} placeholder="e.g. Aziz" autoFocus />
        </label>
        <label>
          <span className="label-row">
            <Mic size={13} /> Microphone
          </span>
          <select value={s.micId} onChange={(e) => update({ micId: e.target.value })}>
            <option value="">System default</option>
            {mics.map((m) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label || "Microphone"}
              </option>
            ))}
          </select>
        </label>

        <div className="split">
          <div className="box">
            <h3>
              <GraduationCap size={18} /> Teach
            </h3>
            <div className="dim">Share a project folder. You run the code, terminals and servers.</div>
            <button className="primary with-icon" disabled={busy} onClick={() => host(false)}>
              <FolderOpen size={15} /> Host a lesson…
            </button>
            <div className="drop-hint">or drag a project folder onto this window</div>
            {hosted && (
              <button className="with-icon" disabled={busy} onClick={() => host(true)} title={hosted.project}>
                <History size={14} /> Reopen {prettyRoom(hosted.room)}
              </button>
            )}
          </div>
          <div className="box">
            <h3>
              <Users size={18} /> Learn
            </h3>
            <div className="dim">Enter the room code your teacher gave you.</div>
            <input
              className="code-input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && join()}
              placeholder="xxxxx-xxxxx"
            />
            <button className="primary with-icon" disabled={busy} onClick={join}>
              <LogIn size={15} /> Join
            </button>
          </div>
        </div>

        {err && <div className="err">{err}</div>}

        <div>
          <a href="#" className="dim label-row" onClick={(e) => (e.preventDefault(), setShowAdv(!showAdv))}>
            {showAdv ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Settings2 size={13} /> Advanced
          </a>
        </div>
        {showAdv && (
          <label>
            Signaling URL (Lambda Function URL, or http://localhost:8787 for the local test server)
            <input value={s.signalingUrl} onChange={(e) => update({ signalingUrl: e.target.value.trim() })} />
          </label>
        )}
      </div>
    </div>
  );
}
