// Jupyter notebook view: shared cells (Yjs), live outputs, kernel on the host.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MonacoBinding } from "y-monaco";
import * as Y from "yjs";
import {
  ArrowDown,
  ArrowUp,
  Code2,
  Eraser,
  FastForward,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Square,
  TextCursorInput,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { activeNotebooks, type CellType, type KernelInfo } from "../../core/notebooks";
import type { Session } from "../../core/session";
import { monaco } from "../monaco-setup";
import { MIME_ORDER, ansiToHtml, applyCarriageReturns, joinText, markdownToHtml, safeHtml, safeSvg } from "./render";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------- hooks ---

/** Re-render when a Y type changes (shallow). */
function useY(t: Y.AbstractType<any> | null | undefined) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!t) return;
    const f = () => setTick((n) => n + 1);
    t.observe(f);
    return () => t.unobserve(f);
  }, [t]);
}

// ------------------------------------------- kernel completion in cells ---

const cellUri = (path: string, id: string) => monaco.Uri.from({ scheme: "duet-cell", path: "/" + path, fragment: id });

const KIND: Record<string, monaco.languages.CompletionItemKind> = {
  function: monaco.languages.CompletionItemKind.Function,
  class: monaco.languages.CompletionItemKind.Class,
  module: monaco.languages.CompletionItemKind.Module,
  instance: monaco.languages.CompletionItemKind.Variable,
  statement: monaco.languages.CompletionItemKind.Variable,
  keyword: monaco.languages.CompletionItemKind.Keyword,
  param: monaco.languages.CompletionItemKind.Variable,
  path: monaco.languages.CompletionItemKind.File,
  property: monaco.languages.CompletionItemKind.Property,
};

monaco.languages.registerCompletionItemProvider("python", {
  triggerCharacters: ["."],
  async provideCompletionItems(model, position) {
    if (model.uri.scheme !== "duet-cell" || !activeNotebooks) return null;
    const path = model.uri.path.replace(/^\//, "");
    const r = await activeNotebooks.complete(path, model.getValue(), model.getOffsetAt(position));
    if (!r?.matches?.length) return null;
    const start = model.getPositionAt(r.cursor_start);
    const end = model.getPositionAt(r.cursor_end);
    const range = { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column };
    const types = r.metadata?._jupyter_types_experimental;
    return {
      suggestions: r.matches.slice(0, 1000).map((m, i) => ({
        label: m,
        kind: KIND[types?.[i]?.type ?? ""] ?? monaco.languages.CompletionItemKind.Text,
        detail: types?.[i]?.signature || types?.[i]?.type,
        insertText: m,
        range,
        sortText: String(i).padStart(5, "0"),
      })),
    };
  },
});

// ------------------------------------------------------------- the view ---

const nbCellCount = (nb: Y.Map<any> | null) => (nb?.get("cells") as Y.Array<any> | undefined)?.length ?? 0;

interface Props {
  session: Session;
  path: string;
  canRun: boolean;
}

export function NotebookView({ session, path, canRun }: Props) {
  const nbs = session.notebooks;
  const [nb, setNb] = useState<Y.Map<any> | null>(() => nbs.nb(path));
  const [active, setActive] = useState<string | null>(null);
  const [editingMd, setEditingMd] = useState<Set<string>>(new Set());
  const editors = useRef(new Map<string, monaco.editor.IStandaloneCodeEditor>());
  const cellsRef = useRef<HTMLDivElement>(null);

  // Tell the partner which cells are on our screen (their visibility preview).
  useEffect(() => {
    const box = cellsRef.current;
    if (!box) return;
    let t = 0;
    const publish = () => {
      if (t) return;
      t = window.setTimeout(() => {
        t = 0;
        const r = box.getBoundingClientRect();
        const cells: string[] = [];
        box.querySelectorAll<HTMLElement>("[data-cell]").forEach((el) => {
          const c = el.getBoundingClientRect();
          if (c.bottom > r.top + 4 && c.top < r.bottom - 4) cells.push(el.dataset.cell!);
        });
        session.awareness.setLocalStateField("nbView", { path, cells });
      }, 100);
    };
    publish();
    box.addEventListener("scroll", publish, { passive: true });
    const ro = new ResizeObserver(publish);
    ro.observe(box);
    return () => {
      clearTimeout(t);
      box.removeEventListener("scroll", publish);
      ro.disconnect();
      session.awareness.setLocalStateField("nbView", null);
    };
    // Re-run when the notebook loads or cells are added / removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, path, nb, nbCellCount(nb)]);

  // The notebook object can change: reload after a host restart, removal...
  useEffect(() => {
    const refresh = () => setNb(nbs.nb(path));
    let map = nbs.map;
    map.observe(refresh);
    refresh();
    // After a rename the notebook must be loaded under its new path.
    if (!nbs.nb(path)) void nbs.open(path).then(refresh, refresh);
    const off = session.on("doc", () => {
      map.unobserve(refresh);
      map = nbs.map;
      map.observe(refresh);
      void nbs.open(path).then(refresh, refresh);
    });
    return () => {
      map.unobserve(refresh);
      off();
    };
  }, [session, nbs, path]);

  const cells = (nb?.get("cells") as Y.Array<Y.Map<any>>) ?? null;
  useY(cells);
  useY(nb);
  const list = cells ? cells.toArray() : [];
  const kernel = (nb?.get("kernel") as KernelInfo) ?? { state: "off" };

  const act = useCallback(
    (fn: () => Promise<unknown> | void) => {
      try {
        const r = fn();
        if (r instanceof Promise) r.catch((e) => session.toast(String(e instanceof Error ? e.message : e)));
      } catch (e) {
        session.toast(String(e instanceof Error ? e.message : e));
      }
    },
    [session],
  );

  const focusCell = useCallback((id: string | null, edit = true) => {
    if (!id) return;
    setActive(id);
    if (edit) requestAnimationFrame(() => editors.current.get(id)?.focus());
    requestAnimationFrame(() => document.querySelector(`[data-cell="${id}"]`)?.scrollIntoView({ block: "nearest" }));
  }, []);

  const run = useCallback(
    (ids: string[]) => {
      if (!canRun) return session.toast("The host has not allowed you to run code.");
      act(() => nbs.run(path, ids));
    },
    [canRun, act, nbs, path, session],
  );

  /** Shift+Enter: run (or render markdown) and move to the next cell, adding one at the end. */
  const runAndAdvance = useCallback(
    (id: string, insertBelow = false) => {
      const i = list.findIndex((c) => c.get("id") === id);
      const c = list[i];
      if (!c) return;
      if (c.get("type") === "code") run([id]);
      else setEditingMd((s) => (s.delete(id), new Set(s)));
      if (insertBelow || i === list.length - 1) {
        const nid = nbs.insertCell(path, i + 1, "code");
        setTimeout(() => focusCell(nid), 30);
      } else focusCell(list[i + 1].get("id"), list[i + 1].get("type") === "code");
    },
    [list, run, nbs, path, focusCell],
  );

  const addCell = (type: CellType, at: number) => {
    const id = nbs.insertCell(path, at, type);
    if (type === "markdown") setEditingMd((s) => new Set(s).add(id));
    setTimeout(() => focusCell(id), 30);
  };

  if (!nb || !cells) {
    return (
      <div className="viewer">
        <div className="dim">Notebook is not available (it may have been moved or deleted).</div>
      </div>
    );
  }

  const busy = kernel.state === "busy" || list.some((c) => c.get("state") !== "idle");
  const isHost = session.role === "host";

  return (
    <div className="nb" data-anchor="notebook">
      <div className="nb-toolbar">
        <button className="tb-btn" disabled={!canRun} title="Run all cells" onClick={() => run(list.filter((c) => c.get("type") === "code").map((c) => c.get("id")))}>
          <FastForward size={15} /> Run all
        </button>
        <button className="tb-btn" disabled={!canRun || !busy} title="Interrupt the kernel" onClick={() => act(() => nbs.interrupt(path))}>
          <Square size={13} fill="currentColor" /> Interrupt
        </button>
        <button className="tb-btn" disabled={!canRun} title="Restart the kernel (variables are lost)" onClick={() => act(() => nbs.restart(path))}>
          <RotateCcw size={14} /> Restart
        </button>
        <button className="tb-btn" title="Clear all outputs" onClick={() => nbs.clearOutputs(path)}>
          <Eraser size={14} /> Clear outputs
        </button>
        <span className="toolbar-sep" />
        <button className="tb-btn" title="Add a code cell at the end" onClick={() => addCell("code", list.length)}>
          <Plus size={14} /> Code
        </button>
        <button className="tb-btn" title="Add a markdown cell at the end" onClick={() => addCell("markdown", list.length)}>
          <Plus size={14} /> Markdown
        </button>
        <div className="grow" />
        <KernelBadge kernel={kernel} />
      </div>

      {kernel.state === "missing" && (
        <div className="nb-banner">
          <TriangleAlert size={16} />
          <div className="grow">
            <b>ipykernel is not installed</b> for <span className="mono">{kernel.python || "python"}</span>.
            {isHost ? " Install it once to run notebook cells." : " Ask the host to install it."}
          </div>
          {isHost && (
            <>
              <button
                className="primary"
                onClick={() =>
                  act(async () => {
                    const py = await nbs.kernelPython();
                    const id = await session.terms.create("Install ipykernel");
                    setTimeout(() => session.terms.input(id, `& "${py}" -m pip install ipykernel\r`), 400);
                  })
                }
              >
                Install ipykernel
              </button>
              <button onClick={() => act(() => nbs.restart(path))}>Retry</button>
            </>
          )}
        </div>
      )}

      <div className="nb-cells" ref={cellsRef}>
        {list.map((c, i) => (
          <div key={c.get("id")}>
            <InsertBar onAdd={(t) => addCell(t, i)} />
            <Cell
              session={session}
              path={path}
              cell={c}
              index={i}
              count={list.length}
              active={active === c.get("id")}
              editingMd={editingMd.has(c.get("id"))}
              canRun={canRun}
              editors={editors.current}
              onFocus={() => setActive(c.get("id"))}
              onEditMd={(on) => setEditingMd((s) => (on ? new Set(s).add(c.get("id")) : (s.delete(c.get("id")), new Set(s))))}
              onRun={() => run([c.get("id")])}
              onRunAdvance={(below) => runAndAdvance(c.get("id"), below)}
            />
          </div>
        ))}
        <InsertBar always onAdd={(t) => addCell(t, list.length)} />
      </div>
    </div>
  );
}

function KernelBadge({ kernel }: { kernel: KernelInfo }) {
  const label: Record<KernelInfo["state"], string> = {
    off: "Kernel not started",
    starting: "Starting kernel…",
    idle: "Idle",
    busy: "Busy",
    restarting: "Restarting…",
    dead: "Kernel stopped",
    missing: "ipykernel missing",
  };
  const py = kernel.python ? kernel.python.split(/[\\/]/).slice(-3).join("/") : "";
  return (
    <span className={`nb-kernel nb-kernel-${kernel.state}`} title={`${kernel.python ?? ""}${kernel.message ? `\n${kernel.message}` : ""}`}>
      <span className="conn-dot" />
      Python {kernel.python_version ?? ""} {py && <span className="dim">({py})</span>} · {label[kernel.state]}
    </span>
  );
}

function InsertBar({ onAdd, always }: { onAdd: (t: CellType) => void; always?: boolean }) {
  return (
    <div className={`nb-insert${always ? " always" : ""}`}>
      <button onClick={() => onAdd("code")}>
        <Plus size={12} /> Code
      </button>
      <button onClick={() => onAdd("markdown")}>
        <Plus size={12} /> Markdown
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ cell ---

interface CellProps {
  session: Session;
  path: string;
  cell: Y.Map<any>;
  index: number;
  count: number;
  active: boolean;
  editingMd: boolean;
  canRun: boolean;
  editors: Map<string, monaco.editor.IStandaloneCodeEditor>;
  onFocus: () => void;
  onEditMd: (on: boolean) => void;
  onRun: () => void;
  onRunAdvance: (insertBelow: boolean) => void;
}

function Cell(p: CellProps) {
  const { cell, session, path } = p;
  useY(cell);
  const id = cell.get("id") as string;
  const type = cell.get("type") as CellType;
  const state = cell.get("state") as string;
  const exec = cell.get("exec") as number | null;
  const nbs = session.notebooks;
  const showEditor = type !== "markdown" || p.editingMd || !(cell.get("source") as Y.Text).length;

  return (
    <div
      className={`nb-cell nb-${type}${p.active ? " active" : ""}${state !== "idle" ? ` ${state}` : ""}`}
      data-cell={id}
      data-anchor={`cell-${id}`}
      onMouseDown={p.onFocus}
    >
      <div className="nb-gutter">
        {type === "code" ? (
          <>
            <button
              className="nb-run"
              disabled={!p.canRun}
              title={state === "idle" ? "Run cell (Ctrl+Enter)" : "Interrupt"}
              onClick={() => (state === "idle" ? p.onRun() : void nbs.interrupt(path))}
            >
              {state === "running" ? <Loader2 size={14} className="spin" /> : state === "queued" ? <Square size={11} /> : <Play size={13} fill="currentColor" />}
            </button>
            <span className="nb-exec">[{state === "running" || state === "queued" ? "*" : (exec ?? " ")}]</span>
          </>
        ) : null}
      </div>
      <div className="nb-main">
        {showEditor ? (
          <CellEditor {...p} type={type} />
        ) : (
          <div
            className="nb-markdown"
            title="Double-click to edit"
            onDoubleClick={() => p.onEditMd(true)}
            dangerouslySetInnerHTML={{ __html: markdownToHtml((cell.get("source") as Y.Text).toString()) }}
          />
        )}
        {type === "code" && <Outputs outputs={cell.get("outputs") as Y.Array<any>} />}
      </div>
      <div className="nb-cell-tools" onMouseDown={(e) => e.stopPropagation()}>
        <button className="icon" title="Move up" disabled={p.index === 0} onClick={() => nbs.moveCell(path, id, -1)}>
          <ArrowUp size={14} />
        </button>
        <button className="icon" title="Move down" disabled={p.index === p.count - 1} onClick={() => nbs.moveCell(path, id, 1)}>
          <ArrowDown size={14} />
        </button>
        <button
          className="icon"
          title={type === "code" ? "Change to markdown" : "Change to code"}
          onClick={() => {
            nbs.setType(path, id, type === "code" ? "markdown" : "code");
            if (type === "code") p.onEditMd(true);
          }}
        >
          {type === "code" ? <TextCursorInput size={14} /> : <Code2 size={14} />}
        </button>
        <button className="icon" title="Delete cell" onClick={() => nbs.deleteCell(path, id)}>
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

function CellEditor(p: CellProps & { type: CellType }) {
  const ref = useRef<HTMLDivElement>(null);
  const { cell, session, path } = p;
  const id = cell.get("id") as string;
  const cb = useRef(p);
  cb.current = p;

  useEffect(() => {
    const ytext = cell.get("source") as Y.Text;
    const uri = cellUri(path, id);
    monaco.editor.getModel(uri)?.dispose();
    const model = monaco.editor.createModel(ytext.toString(), p.type === "code" ? "python" : "markdown", uri);
    model.setEOL(monaco.editor.EndOfLineSequence.LF);
    const ed = monaco.editor.create(ref.current!, {
      model,
      theme: "duet",
      automaticLayout: true,
      minimap: { enabled: false },
      lineNumbers: "off",
      glyphMargin: false,
      folding: false,
      lineDecorationsWidth: 10,
      lineNumbersMinChars: 0,
      scrollBeyondLastLine: false,
      scrollbar: { vertical: "hidden", horizontal: "auto", alwaysConsumeMouseWheel: false, verticalScrollbarSize: 0 },
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      renderLineHighlight: "none",
      wordWrap: p.type === "code" ? "off" : "on",
      fontFamily: "Cascadia Code, Consolas, SF Mono, Menlo, monospace",
      fontSize: 14,
      padding: { top: 8, bottom: 8 },
      fixedOverflowWidgets: true,
      quickSuggestions: { other: true, comments: false, strings: false },
      wordBasedSuggestions: "currentDocument",
      tabSize: 4,
      contextmenu: true,
    });
    const binding = new MonacoBinding(ytext, model, new Set([ed]), session.awareness);
    p.editors.set(id, ed);
    const fit = () => {
      if (ref.current) ref.current.style.height = `${Math.max(36, ed.getContentHeight())}px`;
    };
    fit();
    const subs = [
      ed.onDidContentSizeChange(fit),
      ed.onDidFocusEditorText(() => cb.current.onFocus()),
      ed.onKeyDown((e) => {
        if (e.keyCode !== monaco.KeyCode.Enter) return;
        if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          cb.current.onRunAdvance(false);
        } else if (e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          cb.current.onRunAdvance(true);
        } else if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
          if (cb.current.type === "code") cb.current.onRun();
          else cb.current.onEditMd(false);
        }
      }),
      ed.onKeyDown((e) => {
        if (e.keyCode === monaco.KeyCode.Escape && cb.current.type === "markdown" && ytext.length) cb.current.onEditMd(false);
      }),
    ];
    if (p.type === "markdown" && p.editingMd) setTimeout(() => ed.focus(), 0);
    return () => {
      subs.forEach((s) => s.dispose());
      binding.destroy();
      p.editors.delete(id);
      ed.dispose();
      model.dispose();
    };
    // The editor is rebuilt when the cell type (language) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell, path, id, p.type, session]);

  return <div className="nb-editor" ref={ref} />;
}

// --------------------------------------------------------------- outputs ---

function Outputs({ outputs }: { outputs: Y.Array<any> }) {
  useY(outputs);
  const items = outputs.toArray();
  if (!items.length) return null;
  return (
    <div className="nb-outputs">
      {items.map((o, i) => (
        <Output key={i} o={o} />
      ))}
    </div>
  );
}

function Output({ o }: { o: any }) {
  const html = useMemo(() => {
    if (o.output_type === "stream") return ansiToHtml(applyCarriageReturns(joinText(o.text)));
    if (o.output_type === "error") return ansiToHtml((o.traceback ?? []).join("\n") || `${o.ename}: ${o.evalue}`);
    return null;
  }, [o]);

  if (o.output_type === "stream") return <pre className={`nb-out nb-stream${o.name === "stderr" ? " stderr" : ""}`} dangerouslySetInnerHTML={{ __html: html! }} />;
  if (o.output_type === "error") return <pre className="nb-out nb-error" dangerouslySetInnerHTML={{ __html: html! }} />;
  const data = o.data ?? {};
  const mime = MIME_ORDER.find((m) => m in data);
  if (!mime) return null;
  const v = joinText(data[mime]);
  switch (mime) {
    case "image/png":
    case "image/jpeg":
    case "image/gif":
      return (
        <div className="nb-out nb-image">
          <img src={`data:${mime};base64,${v.replace(/\s/g, "")}`} alt="output" />
        </div>
      );
    case "image/svg+xml":
      return <div className="nb-out nb-image" dangerouslySetInnerHTML={{ __html: safeSvg(v) }} />;
    case "text/html":
      return <div className="nb-out nb-html" dangerouslySetInnerHTML={{ __html: safeHtml(v) }} />;
    case "text/markdown":
      return <div className="nb-out nb-markdown" dangerouslySetInnerHTML={{ __html: markdownToHtml(v) }} />;
    case "text/latex":
      return <div className="nb-out nb-markdown" dangerouslySetInnerHTML={{ __html: markdownToHtml(v) }} />;
    case "application/json":
      return <pre className="nb-out">{JSON.stringify(data[mime], null, 2)}</pre>;
    default:
      return <pre className="nb-out" dangerouslySetInnerHTML={{ __html: ansiToHtml(v) }} />;
  }
}
