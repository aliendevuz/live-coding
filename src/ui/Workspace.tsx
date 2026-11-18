import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  PanelBottom,
  PanelLeft,
  PenLine,
  ScanEye,
  Search,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  Wifi,
  Zap,
  ZoomIn,
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
import { Logo } from "./icons";
import { useLayout, stepZoom } from "./layout";
import { attachLsp, detachLsp } from "./lsp-providers";
import { prettyRoom } from "./Lobby";
import { Palette, type Command } from "./Palette";
import { PointerOverlay, type Tool } from "./PointerOverlay";
import { VisibilityOverlay } from "./VisibilityOverlay";

const STATE_LABEL: Record<string, string> = {
  waiting: "Waiting for partner",
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  closed: "Closed",
};

const IS_MAC = navigator.userAgent.includes("Mac");
const MOD = IS_MAC ? "Cmd" : "Ctrl";

/** Start dragging a splitter; `apply` gets the new size. */
function startDrag(e: React.MouseEvent, axis: "x" | "y", from: number, min: number, max: number, invert: boolean, apply: (v: number) => void) {
  e.preventDefault();
  const p0 = axis === "x" ? e.clientX : e.clientY;
  const move = (ev: MouseEvent) => {
    const d = (axis === "x" ? ev.clientX : ev.clientY) - p0;
    apply(Math.round(Math.max(min, Math.min(max, from + (invert ? -d : d)))));
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    document.body.style.cursor = "";
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
  document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
}

const LSP_NAMES = { python: "Python", ts: "JS/TS" } as const;

function LspBadge({ status }: { status: LspStatus }) {
  const parts = (Object.keys(status) as (keyof LspStatus)[]).filter((k) => status[k].state !== "off");
  if (!parts.length) return null;
  return (
    <span className="sb-item sb-lsp" title={parts.map((k) => `${LSP_NAMES[k]}: ${status[k].state}${status[k].error ? ` — ${status[k].error}` : ""}`).join("\n")}>
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
  const lspStatus = useEvent(session.lsp, "status", session.lsp.status);
  const [muted, setMuted] = useState(session.audio.muted);
  const [tool, setTool] = useState<Tool>(null);
  const [follow, setFollow] = useState(session.role === "guest");
  const [layout, setLayout] = useLayout();
  const [preview, setPreview] = useState(false);
  const [palette, setPalette] = useState<"files" | "commands" | null>(null);
  const [unread, setUnread] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [lastError, setLastError] = useState("");
  const [activePath, setActivePath] = useState<string | null>(null);
  const [peerPath, setPeerPath] = useState<string | null>(null);
  const editorRef = useRef<EditorHandle>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  // Narrow windows give the code room first: chat folds away under 860 px,
  // the explorer under 620 px. A toggle while narrow overrides that until the
  // window crosses the threshold again.
  const [width, setWidth] = useState(innerWidth);
  useEffect(() => {
    const f = () => setWidth(innerWidth);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  const narrowChat = width < 860;
  const narrowExplorer = width < 620;
  const [override, setOverride] = useState<{ chat?: boolean; explorer?: boolean }>({});
  useEffect(() => setOverride((o) => ({ ...o, chat: undefined })), [narrowChat]);
  useEffect(() => setOverride((o) => ({ ...o, explorer: undefined })), [narrowExplorer]);
  const showChat = override.chat ?? (layout.chat && !narrowChat);
  const showExplorer = override.explorer ?? (layout.explorer && !narrowExplorer);

  const isHost = session.role === "host";
  const canTerm = isHost || perms.terminal;
  const peerColor = peer?.color ?? "#888";

  useEffect(() => {
    attachLsp(session.lsp);
    return () => detachLsp(session.lsp);
  }, [session]);

  useEffect(() => {
    const offs = [
      session.on("toast", (t) => {
        setToasts((ts) => [...ts, t]);
        setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== t.id)), t.action ? 15000 : 6000);
      }),
      session.on("chat", () => !visRef.current.chat && setUnread((n) => n + 1)),
      session.on("error", (e) => setLastError(e)),
      session.on("state", (s) => s === "connected" && setLastError("")),
    ];
    return () => offs.forEach((f) => f());
  }, [session]);

  // Which file the partner has open (explorer marker).
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
      publishLayout();
    });
    return () => {
      aw.off("change", read);
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Run shows its output: the panel opens for whoever pressed Run, and for
  // the partner only while they follow.
  const followRef = useRef(follow);
  followRef.current = follow;
  useEffect(
    () =>
      session.terms.on("reveal", ({ remote }) => {
        if (!remote || followRef.current) setLayout({ panel: true });
      }),
    [session, setLayout],
  );

  // Our open panes, for the partner's visibility preview.
  const publishLayout = useCallback(
    () => session.awareness.setLocalStateField("layout", { explorer: showExplorer, panel: layout.panel, chat: showChat }),
    [session, showExplorer, layout.panel, showChat],
  );
  useEffect(publishLayout, [publishLayout]);

  // ------------------------------------------------------------- actions ---

  const visRef = useRef({ chat: showChat, explorer: showExplorer, narrowChat, narrowExplorer });
  visRef.current = { chat: showChat, explorer: showExplorer, narrowChat, narrowExplorer };
  const toggle = useCallback((k: "explorer" | "panel" | "chat") => {
    const v = visRef.current;
    if (k === "chat" && v.narrowChat) setOverride((o) => ({ ...o, chat: !v.chat }));
    else if (k === "explorer" && v.narrowExplorer) setOverride((o) => ({ ...o, explorer: !v.explorer }));
    else setLayout((l) => ({ [k]: !l[k] }));
    if (k === "chat") setUnread(0);
  }, [setLayout]);

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

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      session.setMuted(!m);
      return !m;
    });
  }, [session]);

  const copyRoom = () => {
    void navigator.clipboard.writeText(prettyRoom(session.room));
    session.toast("Room code copied. Send it to your student.");
  };

  const newTerminal = useCallback(() => {
    setLayout({ panel: true });
    session.terms.create().catch((e) => session.toast(String(e instanceof Error ? e.message : e)));
  }, [session, setLayout]);

  const toggleFullscreen = useCallback(async () => {
    const w = getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen()));
  }, []);

  const loadFiles = useCallback(async () => {
    const items = isHost
      ? await invoke<{ path: string }[]>("fs_clone_list")
      : await session.rpc.call<{ path: string }[]>("clone.list");
    return items.map((i) => i.path);
  }, [isHost, session]);

  const commands: Command[] = useMemo(
    () => [
      { id: "files", title: "Go to File…", keys: `${MOD}+P`, run: () => setPalette("files") },
      { id: "explorer", title: "View: Toggle Explorer", keys: `${MOD}+B`, run: () => toggle("explorer") },
      { id: "panel", title: "View: Toggle Terminal Panel", keys: `${MOD}+\` / ${MOD}+J`, run: () => toggle("panel") },
      { id: "chat", title: "View: Toggle Chat", keys: `${MOD}+Alt+B`, run: () => toggle("chat") },
      { id: "preview", title: "View: Toggle Partner Visibility Preview", keys: `${MOD}+Alt+V`, run: () => setPreview((p) => !p) },
      { id: "follow", title: "View: Toggle Follow Partner", keys: `${MOD}+Alt+F`, run: () => setFollow((f) => !f) },
      { id: "zoomin", title: "View: Zoom In", keys: `${MOD}+=`, run: () => setLayout((l) => ({ zoom: stepZoom(l.zoom, 1) })) },
      { id: "zoomout", title: "View: Zoom Out", keys: `${MOD}+-`, run: () => setLayout((l) => ({ zoom: stepZoom(l.zoom, -1) })) },
      { id: "zoomreset", title: "View: Reset Zoom", keys: `${MOD}+0`, run: () => setLayout({ zoom: 1 }) },
      { id: "fullscreen", title: "View: Toggle Full Screen", keys: "F11", run: () => void toggleFullscreen() },
      { id: "terminal", title: "Terminal: New Terminal", keys: `${MOD}+Shift+\``, run: newTerminal },
      { id: "mute", title: "Audio: Toggle Microphone", keys: `${MOD}+Shift+M`, run: toggleMute },
      { id: "laser", title: "Draw: Laser Pointer", keys: "Ctrl+Alt+L", run: () => setTool((t) => (t === "laser" ? null : "laser")) },
      { id: "pen", title: "Draw: Pen", keys: "Ctrl+Alt+P", run: () => setTool((t) => (t === "pen" ? null : "pen")) },
      { id: "hl", title: "Draw: Highlighter", keys: "Ctrl+Alt+H", run: () => setTool((t) => (t === "highlighter" ? null : "highlighter")) },
      {
        id: "clear",
        title: "Draw: Clear Drawings",
        keys: "Ctrl+Alt+C",
        run: () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, altKey: true })),
      },
      { id: "copyroom", title: "Lesson: Copy Room Code", run: copyRoom },
      ...(isHost
        ? [{ id: "perm", title: "Lesson: Toggle Student Terminal Access", run: () => session.setPerms({ ...session.perms, terminal: !session.perms.terminal }) }]
        : []),
      { id: "leave", title: "Lesson: Leave", run: () => void leave() },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toggle, setLayout, toggleFullscreen, newTerminal, toggleMute, isHost, session, leave],
  );

  // ----------------------------------------------------------- shortcuts ---
  // Captured before Monaco and xterm see them, like VS Code's workbench keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      const c = e.code;
      let handled = true;
      if (e.key === "F11") void toggleFullscreen();
      else if (e.key === "F1") setPalette("commands");
      else if (!mod) handled = false;
      else if (e.altKey && !e.shiftKey && c === "KeyB") toggle("chat");
      else if (e.altKey && !e.shiftKey && c === "KeyV") setPreview((p) => !p);
      else if (e.altKey && !e.shiftKey && c === "KeyF") setFollow((f) => !f);
      else if (e.altKey) handled = false;
      else if (!e.shiftKey && c === "KeyB") toggle("explorer");
      else if (!e.shiftKey && (c === "Backquote" || c === "KeyJ")) toggle("panel");
      else if (e.shiftKey && c === "Backquote") newTerminal();
      else if (!e.shiftKey && c === "KeyP") setPalette("files");
      else if (e.shiftKey && c === "KeyP") setPalette("commands");
      else if (e.shiftKey && c === "KeyM") toggleMute();
      else if (c === "Equal" || c === "NumpadAdd") setLayout((l) => ({ zoom: stepZoom(l.zoom, 1) }));
      else if (c === "Minus" || c === "NumpadSubtract") setLayout((l) => ({ zoom: stepZoom(l.zoom, -1) }));
      else if (c === "Digit0" || c === "Numpad0") setLayout({ zoom: 1 });
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toggle, newTerminal, toggleMute, toggleFullscreen, setLayout]);

  // Zoom indicator, briefly, like VS Code.
  const [zoomHint, setZoomHint] = useState(false);
  const firstZoom = useRef(true);
  useEffect(() => {
    if (firstZoom.current) {
      firstZoom.current = false;
      return;
    }
    setZoomHint(true);
    const t = setTimeout(() => setZoomHint(false), 1200);
    return () => clearTimeout(t);
  }, [layout.zoom]);

  // --------------------------------------------------------------- render ---

  const statusClass = state === "connected" ? "" : state === "waiting" ? " waiting" : " offline";
  const mainH = mainRef.current?.clientHeight ?? 700;

  return (
    <div className="ws">
      <div className="titlebar" data-anchor="titlebar">
        <div className="tb-left">
          <Logo />
          <span className="brand">Duet</span>
          <button className="room" title="Room code — click to copy" onClick={copyRoom}>
            <Link2 size={13} />
            <span className="room-code">{prettyRoom(session.room)}</span>
            <Copy size={12} className="dim" />
          </button>
          <span className={`conn conn-${state}`} title={STATE_LABEL[state]}>
            <span className="conn-dot" />
            <span className="conn-label">{STATE_LABEL[state]}</span>
          </span>
          <button className="tb-btn search-btn" title={`Go to file (${MOD}+P) · Commands (${MOD}+Shift+P)`} onClick={() => setPalette("files")}>
            <Search size={14} />
            <span>Search</span>
          </button>
        </div>

        <div className="toolbar" role="toolbar" aria-label="Drawing tools">
          <ToolButton active={!tool} title="Pointer (Esc)" onClick={() => setTool(null)} icon={MousePointer2} />
          <ToolButton active={tool === "laser"} title="Laser pointer (Ctrl+Alt+L)" onClick={() => setTool(tool === "laser" ? null : "laser")} icon={Zap} />
          <ToolButton active={tool === "pen"} title="Pen (Ctrl+Alt+P)" onClick={() => setTool(tool === "pen" ? null : "pen")} icon={PenLine} />
          <ToolButton active={tool === "highlighter"} title="Highlighter (Ctrl+Alt+H)" onClick={() => setTool(tool === "highlighter" ? null : "highlighter")} icon={Highlighter} />
          <span className="toolbar-sep" />
          <ToolButton
            title="Clear drawings (Ctrl+Alt+C)"
            onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", ctrlKey: true, altKey: true }))}
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
          <button className={`tb-btn${muted ? " warn" : ""}`} onClick={toggleMute} title={`${muted ? "Unmute" : "Mute"} microphone (${MOD}+Shift+M)`}>
            {muted ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
          <button
            className={`tb-btn${follow ? " on" : ""}`}
            disabled={!peer}
            title={`Follow ${peer?.name ?? "partner"}: open the same file and scroll with them (${MOD}+Alt+F)`}
            onClick={() => setFollow(!follow)}
          >
            {follow ? <Eye size={16} /> : <EyeOff size={16} />}
            <span>Follow</span>
          </button>
          <button
            className={`tb-btn${preview ? " on preview-on" : ""}`}
            disabled={!peer}
            title={`Visibility preview: shade what ${peer?.name ?? "your partner"} cannot see on their screen (${MOD}+Alt+V)`}
            onClick={() => setPreview(!preview)}
          >
            <ScanEye size={16} />
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
          <span className="tb-sep" />
          <button className={`tb-btn layout-btn${showExplorer ? " on" : ""}`} title={`Toggle Explorer (${MOD}+B)`} onClick={() => toggle("explorer")}>
            <PanelLeft size={16} />
          </button>
          <button className={`tb-btn layout-btn${layout.panel ? " on" : ""}`} title={`Toggle Terminal Panel (${MOD}+\`)`} onClick={() => toggle("panel")}>
            <PanelBottom size={16} />
          </button>
          <button className={`tb-btn layout-btn${showChat ? " on" : ""}`} title={`Toggle Chat (${MOD}+Alt+B)`} onClick={() => toggle("chat")}>
            <MessageSquare size={16} />
            {unread > 0 && <span className="badge">{unread}</span>}
          </button>
          <button className="tb-btn leave" onClick={leave} title="Leave the lesson">
            <LogOut size={15} />
            <span>Leave</span>
          </button>
        </div>
      </div>

      <div className="main" ref={mainRef}>
        <div className="side" style={{ width: `min(${layout.leftW}px, 45vw)`, display: showExplorer ? "" : "none" }}>
          <Explorer
            session={session}
            activePath={activePath}
            peerPath={peerPath}
            peerColor={peerColor}
            onOpen={(p) => editorRef.current?.open(p)}
          />
        </div>
        {showExplorer && (
          <div className="splitter-v" onMouseDown={(e) => startDrag(e, "x", layout.leftW, 140, Math.min(700, innerWidth * 0.45), false, (v) => setLayout({ leftW: v }))} />
        )}
        <div className="center">
          <EditorArea
            ref={editorRef}
            session={session}
            follow={follow}
            setFollow={setFollow}
            onActive={setActivePath}
            canRunCode={canTerm && (isHost || state === "connected")}
          />
          {layout.panel && (
            <div className="splitter-h" onMouseDown={(e) => startDrag(e, "y", layout.bottomH, 80, mainH * 0.8, true, (v) => setLayout({ bottomH: v }))} />
          )}
          <div className="bottom-wrap" style={{ height: `min(${layout.bottomH}px, 45%)`, display: layout.panel ? "" : "none" }}>
            <BottomPanel session={session} canTerm={canTerm} follow={follow} />
          </div>
        </div>
        {showChat && (
          <div className="splitter-v" onMouseDown={(e) => startDrag(e, "x", layout.rightW, 180, Math.min(700, innerWidth * 0.45), true, (v) => setLayout({ rightW: v }))} />
        )}
        <div className="side" style={{ width: `min(${layout.rightW}px, 40vw)`, display: showChat ? "" : "none" }}>
          <Chat session={session} onClose={() => toggle("chat")} />
        </div>
      </div>

      <div className={`statusbar${statusClass}`}>
        <span className="role-pill" style={{ background: session.me.color }}>{isHost ? "Host" : "Guest"}</span>
        <span className="sb-state">{STATE_LABEL[state]}</span>
        {state !== "connected" && lastError && (
          <span className="sb-item sb-error" title={lastError}>
            <TriangleAlert size={12} />
            {lastError.slice(0, 90)}
          </span>
        )}
        <div className="right">
          {preview && peer && (
            <span className="sb-item sb-preview" style={{ color: peerColor }}>
              <ScanEye size={12} />
              {peer.name}'s view
            </span>
          )}
          {layout.zoom !== 1 && (
            <button className="sb-item sb-zoom" title={`Reset zoom (${MOD}+0)`} onClick={() => setLayout({ zoom: 1 })}>
              <ZoomIn size={12} />
              {Math.round(layout.zoom * 100)}%
            </button>
          )}
          <LspBadge status={lspStatus} />
          {state === "connected" && stats && (
            <>
              <span className="sb-item sb-net" title="Connection path">
                <Wifi size={12} />
                {stats.path === "relay" ? "relay" : "peer-to-peer"}
              </span>
              <span className="sb-item" title="Round-trip time">
                <Gauge size={12} />
                {Math.round(stats.rtt)} ms
              </span>
              <span className="sb-item sb-net" title="Upload / download">
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

      <VisibilityOverlay session={session} enabled={preview && !!peer} peerName={peer?.name ?? ""} peerColor={peerColor} />
      <PointerOverlay session={session} tool={tool} setTool={setTool} myColor={session.me.color} peerColor={peerColor} peerName={peer?.name ?? ""} />

      {palette && (
        <Palette
          mode={palette}
          commands={commands}
          loadFiles={loadFiles}
          onOpenFile={(p) => editorRef.current?.open(p)}
          onClose={() => setPalette(null)}
        />
      )}

      {zoomHint && <div className="zoom-hint">{Math.round(layout.zoom * 100)}%</div>}

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
