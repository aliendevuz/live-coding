import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from "react";
import { MonacoBinding } from "./monaco-binding";
import type * as Y from "yjs";
import { Download, FileSearch, Loader2, Play, X } from "lucide-react";
import { decodeText } from "../core/files";
import type { Session } from "../core/session";
import { canRun } from "../core/terminals";
import { basename, formatBytes } from "../core/util";
import { currentView, editorRegistry, scrollToLine, topLine } from "./editor-registry";
import { FileIcon, Logo } from "./icons";
import { NotebookView } from "./notebook/NotebookView";
import { monaco } from "./monaco-setup";

type Kind = "text" | "image" | "binary" | "large" | "readonly" | "notebook";
interface Tab {
  path: string;
  kind: Kind;
  size?: number;
  hash?: string;
  url?: string;
}

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif)$/i;
const IMAGE_MIME: Record<string, string> = { svg: "image/svg+xml", ico: "image/x-icon" };

export interface EditorHandle {
  open(path: string): void;
}

interface Props {
  session: Session;
  follow: boolean;
  setFollow: (on: boolean) => void;
  onActive: (path: string | null) => void;
  canRunCode: boolean;
}

export const EditorArea = forwardRef<EditorHandle, Props>(function EditorArea(
  { session, follow, setFollow, onActive, canRunCode },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const edRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const bound = useRef(new Map<string, { model: monaco.editor.ITextModel; binding?: MonacoBinding }>());
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(active);
  activeRef.current = active;
  const followRef = useRef(follow);
  followRef.current = follow;

  // ---- editor instance ----
  useEffect(() => {
    const ed = monaco.editor.create(hostRef.current!, {
      model: null,
      theme: "duet",
      padding: { top: 10 },
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      renderLineHighlight: "all",
      automaticLayout: true,
      fontFamily: "Cascadia Code, Consolas, SF Mono, Menlo, monospace",
      fontSize: 14,
      fontLigatures: true,
      wordWrap: "off",
      minimap: { enabled: true },
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      wordBasedSuggestions: "currentDocument",
      parameterHints: { enabled: true },
      suggest: { showStatusBar: true, preview: true },
      hover: { delay: 400 },
      "semanticHighlighting.enabled": false,
      renderWhitespace: "selection",
      smoothScrolling: true,
      scrollBeyondLastLine: true,
      tabSize: 4,
    });
    edRef.current = ed;
    editorRegistry.editor = ed;
    return () => {
      for (const [, b] of bound.current) {
        b.binding?.destroy();
        b.model.dispose();
      }
      bound.current.clear();
      ed.dispose();
      editorRegistry.editor = null;
      editorRegistry.file = null;
    };
  }, []);

  const unbind = (path: string) => {
    const b = bound.current.get(path);
    if (!b) return;
    b.binding?.destroy();
    b.model.dispose();
    bound.current.delete(path);
  };

  const bindText = useCallback(
    (path: string) => {
      if (bound.current.has(path)) return;
      const ytext = session.files.map.get(path);
      if (!ytext) throw new Error(`${path} is not loaded`);
      const model = monaco.editor.createModel(ytext.toString(), undefined, monaco.Uri.file("/" + path));
      model.setEOL(monaco.editor.EndOfLineSequence.LF);
      const binding = new MonacoBinding(ytext, model, new Set([edRef.current!]), session.awareness);
      bound.current.set(path, { model, binding });
    },
    [session],
  );

  // ---- open / close ----
  const open = useCallback(
    async (path: string, opts: { fromFollow?: boolean } = {}) => {
      if (!opts.fromFollow && followRef.current) setFollow(false);
      const existing = tabsRef.current.find((t) => t.path === path);
      if (existing) {
        setActive(path);
        return;
      }
      if (bound.current.has(path) && session.files.map.has(path)) {
        setTabs((ts) => (ts.some((t) => t.path === path) ? ts : [...ts, { path, kind: "text" }]));
        setActive(path);
        return;
      }
      setLoading(path);
      try {
        const r = await session.files.open(path);
        let tab: Tab;
        if (r.kind === "text") {
          bindText(path);
          tab = { path, kind: "text" };
        } else if (r.kind === "notebook") {
          tab = { path, kind: "notebook" };
        } else if (IMAGE.test(path)) {
          const bytes = await session.files.readBytes(path, r);
          const ext = path.split(".").pop()!.toLowerCase();
          const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: IMAGE_MIME[ext] ?? `image/${ext === "jpg" ? "jpeg" : ext}` });
          tab = { path, kind: "image", url: URL.createObjectURL(blob), size: r.size };
        } else tab = { path, kind: r.kind, size: r.size, hash: r.hash };
        setTabs((ts) => (ts.some((t) => t.path === path) ? ts : [...ts, tab]));
        setActive(path);
      } catch (e) {
        session.toast(`Cannot open ${path}: ${e instanceof Error ? e.message : e}`);
      } finally {
        setLoading(null);
      }
    },
    [session, bindText, setFollow],
  );

  useImperativeHandle(ref, () => ({ open: (p) => void open(p) }), [open]);

  // Go-to-definition: load target files on demand, and open them in a tab.
  useEffect(() => {
    editorRegistry.ensureModel = async (path: string) => {
      if (bound.current.has(path)) return true;
      try {
        const r = await session.files.open(path);
        if (r.kind !== "text") return false;
        bindText(path);
        return true;
      } catch {
        return false;
      }
    };
    const opener = monaco.editor.registerEditorOpener({
      openCodeEditor(_source, resource, selection) {
        if (resource.scheme !== "file") return false;
        const path = resource.path.replace(/^\//, "");
        void (async () => {
          await open(path);
          const ed = edRef.current;
          if (!ed || !selection) return;
          if ("startLineNumber" in selection) {
            ed.setSelection(selection);
            ed.revealRangeInCenterIfOutsideViewport(selection);
          } else {
            ed.setPosition(selection);
            ed.revealPositionInCenterIfOutsideViewport(selection);
          }
        })();
        return true;
      },
    });
    return () => {
      opener.dispose();
      editorRegistry.ensureModel = async () => false;
    };
  }, [session, open, bindText]);

  const close = useCallback((path: string) => {
    const t = tabsRef.current.find((x) => x.path === path);
    if (t?.url) URL.revokeObjectURL(t.url);
    unbind(path);
    setTabs((ts) => {
      const i = ts.findIndex((x) => x.path === path);
      const next = ts.filter((x) => x.path !== path);
      if (activeRef.current === path) setActive(next[Math.min(i, next.length - 1)]?.path ?? null);
      return next;
    });
  }, []);

  const openReadOnly = async (tab: Tab) => {
    setLoading(tab.path);
    try {
      const bytes = await session.files.readBytes(tab.path, tab.hash ? { hash: tab.hash } : undefined);
      const text = decodeText(bytes) ?? new TextDecoder().decode(bytes);
      unbind(tab.path);
      const model = monaco.editor.createModel(text, undefined, monaco.Uri.file("/" + tab.path));
      bound.current.set(tab.path, { model });
      setTabs((ts) => ts.map((t) => (t.path === tab.path ? { ...t, kind: "readonly" } : t)));
    } catch (e) {
      session.toast(String(e));
    } finally {
      setLoading(null);
    }
  };

  // ---- show the active model ----
  const activeTab = tabs.find((t) => t.path === active) ?? null;
  useEffect(() => {
    const ed = edRef.current!;
    const b = active ? bound.current.get(active) : undefined;
    const showsCode = activeTab && (activeTab.kind === "text" || activeTab.kind === "readonly");
    ed.setModel(showsCode && b ? b.model : null);
    ed.updateOptions({ readOnly: activeTab?.kind === "readonly" });
    editorRegistry.file = showsCode ? active : null;
    session.awareness.setLocalStateField("file", active);
    session.awareness.setLocalStateField("top", showsCode ? topLine() : 1);
    session.awareness.setLocalStateField("view", showsCode ? currentView() : null);
    onActive(active);
    if (showsCode) ed.focus();
  }, [active, activeTab?.kind, session, onActive]);

  // Publish where we are scrolled, for the peer's follow mode.
  useEffect(() => {
    const ed = edRef.current!;
    let t = 0;
    // Publish where we are scrolled (follow mode) and what we can see
    // (the partner's visibility preview).
    const publish = () => {
      if (t) return;
      t = window.setTimeout(() => {
        t = 0;
        if (!editorRegistry.file) return;
        session.awareness.setLocalStateField("top", topLine());
        session.awareness.setLocalStateField("view", currentView());
      }, 80);
    };
    const subs = [ed.onDidScrollChange(publish), ed.onDidLayoutChange(publish)];
    return () => subs.forEach((x) => x.dispose());
  }, [session]);

  // ---- follow the peer ----
  useEffect(() => {
    if (!follow) return;
    let awareness = session.awareness;
    const apply = () => {
      for (const [id, st] of awareness.getStates()) {
        if (id === session.doc.clientID || !st.file) continue;
        if (st.file !== activeRef.current) void open(st.file, { fromFollow: true });
        else if (typeof st.top === "number" && editorRegistry.file === st.file) scrollToLine(st.top);
      }
    };
    awareness.on("change", apply);
    apply();
    const offDoc = session.on("doc", () => {
      awareness.off("change", apply);
      awareness = session.awareness;
      awareness.on("change", apply);
    });
    return () => {
      awareness.off("change", apply);
      offDoc();
    };
  }, [follow, session, open]);

  // ---- colors for the peer's cursor and selection ----
  useEffect(() => {
    const style = document.createElement("style");
    document.head.appendChild(style);
    let awareness = session.awareness;
    const paint = () => {
      let css = "";
      for (const [id, st] of awareness.getStates()) {
        const c = st.user?.color;
        if (!c || id === session.doc.clientID) continue;
        css += `.yRemoteSelection-${id}{background-color:${c}66}`;
        // Just a caret in the partner's color; the name shows on hover (see app.css).
        css += `.yRemoteSelectionHead-${id}{border-color:${c};--peer:${c}}`;
        css += `.yRemoteSelectionHead-${id}::after{content:"${String(st.user.name).replace(/["\\\n]/g, "")}"}`;
      }
      style.textContent = css;
    };
    awareness.on("change", paint);
    const offDoc = session.on("doc", () => {
      awareness.off("change", paint);
      awareness = session.awareness;
      awareness.on("change", paint);
    });
    return () => {
      awareness.off("change", paint);
      offDoc();
      style.remove();
    };
  }, [session]);

  // ---- files deleted / renamed / document replaced ----
  useEffect(() => {
    let map: Y.Map<Y.Text> = session.files.map;
    const onMap = (ev: Y.YMapEvent<Y.Text>) => {
      ev.keysChanged.forEach((k) => {
        if (map.has(k)) return;
        const t = tabsRef.current.find((x) => x.path === k && x.kind === "text");
        // A rename re-adds the key under a new name in the same transaction; the
        // `renamed` handler moves the tab, so only close truly deleted files.
        if (t) setTimeout(() => !session.files.map.has(k) && tabsRef.current.some((x) => x.path === k) && close(k), 50);
      });
    };
    map.observe(onMap);
    const offRename = session.files.on("renamed", ({ from, to }) => {
      const moved = tabsRef.current.filter((t) => t.path === from || t.path.startsWith(from + "/"));
      for (const t of moved) {
        const np = to + t.path.slice(from.length);
        unbind(t.path);
        setTabs((ts) => ts.map((x) => (x.path === t.path ? { ...x, path: np } : x)));
        if (activeRef.current === t.path) setActive(np);
        if (t.kind === "text") {
          const tryBind = () => (session.files.map.has(np) ? bindText(np) : setTimeout(tryBind, 50));
          tryBind();
        }
      }
    });
    const offDoc = session.on("doc", () => {
      map.unobserve(onMap);
      map = session.files.map;
      map.observe(onMap);
      // Guest: the host restarted. Reload every open text file from the new document.
      const reopen = tabsRef.current.filter((t) => t.kind === "text").map((t) => t.path);
      for (const p of reopen) unbind(p);
      setTabs((ts) => ts.filter((t) => t.kind !== "text"));
      const was = activeRef.current;
      void (async () => {
        for (const p of reopen) await open(p, { fromFollow: true });
        if (was) setActive(was);
      })();
    });
    return () => {
      map.unobserve(onMap);
      offRename();
      offDoc();
    };
  }, [session, close, bindText, open]);

  // ---- keys ----
  const run = useCallback(() => {
    const p = activeRef.current;
    if (!p) return;
    session.terms.run(p)?.catch?.((e: unknown) => session.toast(String(e instanceof Error ? e.message : e)));
  }, [session]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (session.role === "host") void session.files.flush();
      } else if (e.key === "F5" && canRunCode) {
        e.preventDefault();
        run();
      } else if (e.key === "w" && (e.ctrlKey || e.metaKey) && activeRef.current) {
        e.preventDefault();
        close(activeRef.current);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [session, run, close, canRunCode]);

  return (
    <div className="center" data-anchor="editor">
      <div className="tabs" data-anchor="tabs">
        {tabs.map((t) => (
          <div
            key={t.path}
            className={`tab${t.path === active ? " active" : ""}`}
            title={t.path}
            onClick={() => (followRef.current && setFollow(false), setActive(t.path))}
            onAuxClick={(e) => e.button === 1 && close(t.path)}
          >
            <FileIcon name={t.path} size={14} />
            <span>{basename(t.path)}</span>
            <span
              className="x"
              onClick={(e) => {
                e.stopPropagation();
                close(t.path);
              }}
            >
              <X size={13} />
            </span>
          </div>
        ))}
        <div className="tools">
          {loading && (
            <span className="dim row" style={{ gap: 6 }}>
              <Loader2 size={13} className="spin" />
              {basename(loading)}
            </span>
          )}
          {active && canRun(active) && (
            <button
              className="primary run-btn"
              disabled={!canRunCode}
              title={canRunCode ? "Run this file on the host (F5)" : "The host has not given you terminal access"}
              onClick={run}
            >
              <Play size={13} fill="currentColor" />
              Run
            </button>
          )}
        </div>
      </div>
      <div className="editor-wrap">
        <div className="editor-host" ref={hostRef} style={{ visibility: activeTab && (activeTab.kind === "text" || activeTab.kind === "readonly") ? "visible" : "hidden" }} />
        {activeTab?.kind === "notebook" && (
          <div className="viewer nb-host">
            <NotebookView key={activeTab.path} session={session} path={activeTab.path} canRun={canRunCode} />
          </div>
        )}
        {activeTab?.kind === "image" && (
          <div className="viewer">
            <img src={activeTab.url} alt={activeTab.path} />
          </div>
        )}
        {activeTab && (activeTab.kind === "binary" || activeTab.kind === "large") && (
          <div className="viewer">
            <div className="col" style={{ alignItems: "center" }}>
              <FileIcon name={activeTab.path} size={40} />
              <div style={{ fontSize: 15 }}>{basename(activeTab.path)}</div>
              <div className="dim">
                {activeTab.kind === "large"
                  ? `Large file (${formatBytes(activeTab.size ?? 0)}): not synced live, to keep the connection fast.`
                  : `Binary file (${formatBytes(activeTab.size ?? 0)})`}
              </div>
              <div className="row">
                {activeTab.kind === "large" && (
                  <button className="with-icon" onClick={() => openReadOnly(activeTab)}>
                    <FileSearch size={14} /> Open read-only
                  </button>
                )}
                {session.role === "guest" && (
                  <button className="with-icon" onClick={() => session.files.download(activeTab.path).catch((e) => session.toast(String(e)))}>
                    <Download size={14} /> Download…
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        {!activeTab && (
          <div className="empty">
            <div>
              <div style={{ opacity: 0.35, marginBottom: 12 }}>
                <Logo size={72} />
              </div>
              Open a file from the explorer.
              <br />
              <kbd>F5</kbd> run · <kbd>Ctrl+Alt+L</kbd> laser · <kbd>Ctrl+Alt+P</kbd> pen · <kbd>Ctrl+Alt+H</kbd> highlighter · <kbd>Esc</kbd> stop drawing
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
