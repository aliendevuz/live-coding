import { useCallback, useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Eraser,
  Eye,
  EyeOff,
  Gauge,
  Highlighter,
  Link2,
  Lock,
  LockOpen,
  LogOut,
  MessageSquare,
  Mic,
  MicOff,
  MousePointer2,
  PenLine,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  Wifi,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { LspStatus } from "../core/lsp";
import type { Session, Toast } from "../core/session";
import { formatBytes } from "../core/util";
import { BottomPanel } from "./BottomPanel";
import { Chat } from "./Chat";
import { EditorArea, type EditorHandle } from "./EditorArea";
import { Explorer } from "./Explorer";
import { useEvent } from "./hooks";
import { attachLsp, detachLsp } from "./lsp-providers";
import { Logo } from "./icons";
import { prettyRoom } from "./Lobby";
import { PointerOverlay, type Tool } from "./PointerOverlay";

const STATE_LABEL: Record<string, string> = {
  waiting: "Waiting for partner",
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  closed: "Closed",
};

/** Drag handle that resizes a neighbouring pane. */
function useDrag(initial: number, min: number, max: number, axis: "x" | "y", invert = false) {
  const [size, setSize] = useState(initial);
  const start = (e: React.MouseEvent) => {
    e.preventDefault();
    const s0 = size;
    const p0 = axis === "x" ? e.clientX : e.clientY;
    const move = (ev: MouseEvent) => {
      const d = (axis === "x" ? ev.clientX : ev.clientY) - p0;
      setSize(Math.max(min, Math.min(max, s0 + (invert ? -d : d))));
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
  };
  return [size, start] as const;
}

const LSP_NAMES = { python: "Python", ts: "JS/TS" } as const;

function LspBadge({ status }: { status: LspStatus }) {
  const parts = (Object.keys(status) as (keyof LspStatus)[]).filter((k) => status[k].state !== "off");
  if (!parts.length) return null;
  return (
    <span className="sb-item" title={parts.map((k) => `${LSP_NAMES[k]}: ${status[k].state}${status[k].error ? ` — ${status[k].error}` : ""}`).join("\n")}>
      <Sparkles size={12} />
      {parts.map((k) => {
        const st = status[k].state;
        return (
          <span key={k} className={`lsp-${st}`}>
            {LSP_NAMES[k]}
            {st === "ready" ? "" : st === "unavailable" ? " ✕" : "…"}
          </span>
        );
      })}
    </span>
  );
}

function ToolButton({ icon: Icon, active, title, onClick }: { icon: LucideIcon; active?: boolean; title: string; onClick: () => void }) {
  return (
    <button className={`tool${active ? " active" : ""}`} title={title} aria-pressed={!!active} onClick={onClick}>
      <Icon size={16} strokeWidth={1.9} />
    </button>
  );
}

function Avatar(p: { name: string; color: string; level: number; muted?: boolean; faded?: boolean; title: string }) {
  const speaking = p.level > 0.08;
  return (
    <div
      className={`avatar${speaking ? " speaking" : ""}`}
      title={p.title}
      style={{ background: p.color, opacity: p.faded ? 0.4 : 1, ["--ring" as string]: `${2 + p.level * 3}px`, ["--c" as string]: p.color }}
    >
      {p.name.slice(0, 1).toUpperCase()}
      {p.muted && (
        <span className="avatar-muted">
          <MicOff size={9} strokeWidth={2.5} />
        </span>
      )}
    </div>
  );
}

export function Workspace({ session, onLeave }: { session: Session; onLeave: () => void }) {
  const state = useEvent(session, "state", session.state);
  const peer = useEvent(session, "peer", session.peer);
  const perms = useEvent(session, "perms", session.perms);
  const stats = useEvent(session, "stats", session.stats);
  const levels = useEvent(session, "levels", { me: 0, peer: 0 });
  const [muted, setMuted] = useState(session.audio.muted);
  const [tool, setTool] = useState<Tool>(null);
  const [follow, setFollow] = useState(session.role === "guest");
  const [chatOpen, setChatOpen] = useState(true);
  const [unread, setUnread] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [lastError, setLastError] = useState("");
  const [activePath, setActivePath] = useState<string | null>(null);
  const [peerPath, setPeerPath] = useState<string | null>(null);
  const editorRef = useRef<EditorHandle>(null);
  const lspStatus = useEvent(session.lsp, "status", session.lsp.status);

  useEffect(() => {
    attachLsp(session.lsp);
    return () => detachLsp(session.lsp);
  }, [session]);

  const [leftW, dragLeft] = useDrag(250, 160, 600, "x");
  const [rightW, dragRight] = useDrag(290, 200, 600, "x", true);
  const [bottomH, dragBottom] = useDrag(260, 80, 800, "y", true);

  const isHost = session.role === "host";
  const canTerm = isHost || perms.terminal;
  const peerColor = peer?.color ?? "#888";

  useEffect(() => {
    const offs = [
      session.on("toast", (t) => {
        setToasts((ts) => [...ts, t]);
        setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== t.id)), t.action ? 15000 : 6000);
      }),
      session.on("chat", () => !chatOpen && setUnread((n) => n + 1)),
      session.on("error", (e) => setLastError(e)),
      session.on("state", (s) => s === "connected" && setLastError("")),
    ];
    return () => offs.forEach((f) => f());
  }, [session, chatOpen]);

  // Track which file the partner has open (explorer marker).
  useEffect(() => {
    let aw = session.awareness;
    const read = () => {
      let f: string | null = null;
      for (const [id, st] of aw.getStates()) if (id !== session.doc.clientID && st.file) f = st.file;
      setPeerPath(f);
    };
    aw.on("change", read);
    const off = session.on("doc", () => {
      aw.off("change", read);
      aw = session.awareness;
      aw.on("change", read);
    });
    return () => {
      aw.off("change", read);
      off();
    };
  }, [session]);

  const leave = useCallback(async () => {
    const end = isHost
      ? await ask("End the lesson for everyone? Choose No to just close (you can reopen the same room later).", {
          title: "Leave",
          kind: "warning",
          okLabel: "End lesson",
          cancelLabel: "Just close",
        })
      : false;
    await session.leave(end);
    onLeave();
  }, [session, isHost, onLeave]);

  const toggleMute = () => {
    session.setMuted(!muted);
    setMuted(!muted);
  };

  const copyRoom = () => {
    void navigator.clipboard.writeText(prettyRoom(session.room));
    session.toast("Room code copied. Send it to your student.");
  };

  const statusClass = state === "connected" ? "" : state === "waiting" ? " waiting" : " offline";

  return (
    <div className="ws">
      <div className="titlebar" data-anchor="titlebar">
        <div className="tb-left">
          <Logo />
          <span className="brand">Duet</span>
          <button className="room" title="Room code — click to copy" onClick={copyRoom}>
            <Link2 size={13} />
            {prettyRoom(session.room)}
            <Copy size={12} className="dim" />
          </button>
          <span className={`conn conn-${state}`}>
            <span className="conn-dot" />
            {STATE_LABEL[state]}
          </span>
        </div>

        <div className="toolbar" role="toolbar" aria-label="Drawing tools">
          <ToolButton active={!tool} title="Pointer (Esc)" onClick={() => setTool(null)} icon={MousePointer2} />
          <ToolButton active={tool === "laser"} title="Laser pointer (Ctrl+Alt+L)" onClick={() => setTool(tool === "laser" ? null : "laser")} icon={Zap} />
          <ToolButton active={tool === "pen"} title="Pen (Ctrl+Alt+P)" onClick={() => setTool(tool === "pen" ? null : "pen")} icon={PenLine} />
          <ToolButton active={tool === "highlighter"} title="Highlighter (Ctrl+Alt+H)" onClick={() => setTool(tool === "highlighter" ? null : "highlighter")} icon={Highlighter} />
          <span className="toolbar-sep" />
          <ToolButton
            title="Clear drawings (Ctrl+Alt+C)"
            onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, altKey: true }))}
            icon={Eraser}
          />
        </div>

        <div className="tb-right">
          <div className="avatars">
            <Avatar name={session.me.name} color={session.me.color} level={muted ? 0 : levels.me} title={`${session.me.name} (you)`} />
            {peer && (
              <Avatar
                name={peer.name}
                color={peer.color}
                level={levels.peer}
                muted={peer.muted}
                faded={state !== "connected"}
                title={`${peer.name}${peer.muted ? " (muted)" : ""}`}
              />
            )}
          </div>
          <button className={`tb-btn${muted ? " warn" : ""}`} onClick={toggleMute} title={muted ? "Unmute microphone" : "Mute microphone"}>
            {muted ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
          <button
            className={`tb-btn${follow ? " on" : ""}`}
            disabled={!peer}
            title={`Follow ${peer?.name ?? "partner"}: open the same file and scroll with them`}
            onClick={() => setFollow(!follow)}
          >
            {follow ? <Eye size={16} /> : <EyeOff size={16} />}
            <span>Follow</span>
          </button>
          {isHost && (
            <button
              className={`tb-btn${perms.terminal ? " on" : ""}`}
              title={perms.terminal ? "Student can type in terminals and run code. Click to revoke." : "Student can only watch terminals. Click to allow typing."}
              onClick={() => session.setPerms({ ...perms, terminal: !perms.terminal })}
            >
              {perms.terminal ? <LockOpen size={15} /> : <Lock size={15} />}
              <SquareTerminal size={15} />
            </button>
          )}
          <button className={`tb-btn${chatOpen ? " on" : ""}`} onClick={() => (setChatOpen(!chatOpen), setUnread(0))} title="Chat">
            <MessageSquare size={16} />
            {unread > 0 && <span className="badge">{unread}</span>}
          </button>
          <button className="tb-btn leave" onClick={leave} title="Leave the lesson">
            <LogOut size={15} />
            <span>Leave</span>
          </button>
        </div>
      </div>

      <div className="main">
        <div style={{ width: leftW, flex: "none" }}>
          <Explorer
            session={session}
            activePath={activePath}
            peerPath={peerPath}
            peerColor={peerColor}
            onOpen={(p) => editorRef.current?.open(p)}
          />
        </div>
        <div className="splitter-v" onMouseDown={dragLeft} />
        <div className="center">
          <EditorArea
            ref={editorRef}
            session={session}
            follow={follow}
            setFollow={setFollow}
            onActive={setActivePath}
            canRunCode={canTerm && (isHost || state === "connected")}
          />
          <div className="splitter-h" onMouseDown={dragBottom} />
          <div style={{ height: bottomH, flex: "none" }}>
            <BottomPanel session={session} canTerm={canTerm} />
          </div>
        </div>
        {chatOpen && (
          <>
            <div className="splitter-v" onMouseDown={dragRight} />
            <div style={{ width: rightW, flex: "none" }}>
              <Chat session={session} onClose={() => setChatOpen(false)} />
            </div>
          </>
        )}
      </div>

      <div className={`statusbar${statusClass}`}>
        <span className="role-pill" style={{ background: session.me.color }}>{isHost ? "Host" : "Guest"}</span>
        <span>{STATE_LABEL[state]}</span>
        {state !== "connected" && lastError && (
          <span className="sb-item" title={lastError}>
            <TriangleAlert size={12} />
            {lastError.slice(0, 90)}
          </span>
        )}
        <div className="right">
          <LspBadge status={lspStatus} />
          {state === "connected" && stats && (
            <>
              <span className="sb-item" title="Connection path">
                <Wifi size={12} />
                {stats.path === "relay" ? "relay" : "peer-to-peer"}
              </span>
              <span className="sb-item" title="Round-trip time">
                <Gauge size={12} />
                {Math.round(stats.rtt)} ms
              </span>
              <span className="sb-item" title="Upload / download">
                <ArrowUp size={12} />
                {formatBytes(stats.sendRate)}/s
                <ArrowDown size={12} />
                {formatBytes(stats.recvRate)}/s
              </span>
            </>
          )}
          {follow && peer && (
            <span className="sb-item">
              <Eye size={12} />
              Following {peer.name}
            </span>
          )}
        </div>
      </div>

      <PointerOverlay session={session} tool={tool} setTool={setTool} myColor={session.me.color} peerColor={peerColor} peerName={peer?.name ?? ""} />

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span className="grow">{t.text}</span>
            {t.action && (
              <button
                className="primary"
                onClick={() => {
                  t.action!.run();
                  setToasts((ts) => ts.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
