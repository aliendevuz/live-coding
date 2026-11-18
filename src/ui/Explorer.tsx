// Project explorer, VS Code style: lazy tree, multi-select, drag to move
// (Ctrl = copy), cut/copy/paste, inline rename and new file, keyboard
// navigation, recycle-bin delete, auto-reveal of the open file, and drop
// target for files dragged in from Windows Explorer.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Download,
  FilePlus,
  FolderPlus,
  RefreshCw,
} from "lucide-react";
import type { FsEntry } from "../core/files";
import type { Session } from "../core/session";
import { basename, dirname, formatBytes, joinPath } from "../core/util";
import { FileIcon, FolderIcon } from "./icons";
import { useFileDrop } from "./useFileDrop";

interface Props {
  session: Session;
  activePath: string | null;
  peerPath: string | null;
  peerColor: string;
  onOpen: (path: string) => void;
}

interface Row {
  path: string;
  name: string;
  dir: boolean;
  depth: number;
  entry?: FsEntry;
  /** Placeholder row holding the "new file / folder" input. */
  creating?: { dir: boolean };
}

type Editing = { kind: "rename"; path: string } | { kind: "new"; parent: string; dir: boolean } | null;

interface Menu {
  x: number;
  y: number;
  target: string | null; // null = empty space (project root)
}

interface Drag {
  paths: string[];
  x: number;
  y: number;
  target: string | null; // folder to drop into, null = not allowed here
  copy: boolean;
}

const INVALID = /[<>:"|?*\u0000-\u001f]/;

/** Shared across explorer instances: what Ctrl+C / Ctrl+X picked up. */
let clipboard: { mode: "copy" | "cut"; paths: string[] } | null = null;

const isInside = (p: string, folder: string) => p === folder || p.startsWith(folder + "/");

export function Explorer({ session, activePath, peerPath, peerColor, onOpen }: Props) {
  const files = session.files;
  const isHost = session.role === "host";
  const [listings, setListings] = useState<Map<string, FsEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [cut, setCut] = useState<string[]>([]);
  const [connected, setConnected] = useState(isHost || session.state === "connected");
  const bodyRef = useRef<HTMLDivElement>(null);
  const listingsRef = useRef(listings);
  listingsRef.current = listings;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // ------------------------------------------------------------- loading ---

  const load = useCallback(
    async (dir: string) => {
      try {
        const list = await files.list(dir);
        setListings((m) => new Map(m).set(dir, list));
        return list;
      } catch {
        setListings((m) => {
          const n = new Map(m);
          n.delete(dir);
          return n;
        });
        return null;
      }
    },
    [files],
  );

  const reloadOpen = useCallback(() => {
    for (const d of expandedRef.current) void load(d);
  }, [load]);

  useEffect(() => {
    if (connected) reloadOpen();
  }, [connected, reloadOpen]);

  useEffect(() => {
    const offs = [
      session.on("state", (s) => setConnected(isHost || s === "connected")),
      session.on("peer", () => setConnected(isHost || session.state === "connected")),
      files.on("changed", (dirs) => {
        for (const d of dirs) if (listingsRef.current.has(d) || expandedRef.current.has(d)) void load(d);
      }),
    ];
    return () => offs.forEach((f) => f());
  }, [session, files, load, isHost]);

  const expand = useCallback(
    async (dir: string) => {
      if (!listingsRef.current.has(dir)) await load(dir);
      setExpanded((e) => (e.has(dir) ? e : new Set(e).add(dir)));
    },
    [load],
  );

  const collapse = (dir: string) =>
    setExpanded((e) => {
      const n = new Set(e);
      for (const d of e) if (d && isInside(d, dir)) n.delete(d);
      return n;
    });

  /** Expand every folder above `path` (reveal). */
  const revealPath = useCallback(
    async (path: string) => {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) await expand(parts.slice(0, i).join("/"));
    },
    [expand],
  );

  // ---------------------------------------------------------- visible rows ---

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      if (editing?.kind === "new" && editing.parent === dir) {
        out.push({ path: `${dir}/\u0000new`, name: "", dir: editing.dir, depth, creating: { dir: editing.dir } });
      }
      for (const e of listings.get(dir) ?? []) {
        const path = joinPath(dir, e.name);
        out.push({ path, name: e.name, dir: e.dir, depth, entry: e });
        if (e.dir && expanded.has(path)) walk(path, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }, [listings, expanded, editing]);

  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.path, i])), [rows]);

  // Reveal the file open in the editor, like VS Code's autoReveal.
  useEffect(() => {
    if (!activePath || !connected) return;
    void revealPath(activePath).then(() => {
      setSelection(new Set([activePath]));
      setFocus(activePath);
      setAnchor(activePath);
      requestAnimationFrame(() =>
        bodyRef.current?.querySelector(`[data-path="${CSS.escape(activePath)}"]`)?.scrollIntoView({ block: "nearest" }),
      );
    });
  }, [activePath, connected, revealPath]);

  // ------------------------------------------------------------ operations ---

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        session.toast(String(e instanceof Error ? e.message : e).replace(/^Error: /, ""));
      }
    },
    [session],
  );

  /** Folder a new item / paste goes into, from the focused row. */
  const folderOf = (path: string | null) => {
    if (!path) return "";
    const r = rows[rowIndex.get(path) ?? -1];
    return r?.dir ? path : dirname(path);
  };

  const exists = async (dir: string, name: string) => {
    const list = listingsRef.current.get(dir) ?? (await load(dir)) ?? [];
    return list.some((e) => e.name.toLowerCase() === name.toLowerCase());
  };

  /** Move (or copy) items into `target`. */
  const transfer = useCallback(
    (paths: string[], target: string, copy: boolean) =>
      act(async () => {
        // Moving a folder and something inside it: the folder is enough.
        const items = paths.filter((p) => !paths.some((q) => q !== p && isInside(p, q)));
        const done: string[] = [];
        for (const p of items) {
          if (isInside(target, p)) throw new Error(`Cannot move "${basename(p)}" into itself.`);
          const dest = joinPath(target, basename(p));
          if (copy) {
            done.push(await files.copy(p, dest));
            continue;
          }
          if (dirname(p) === target) continue;
          if (await exists(target, basename(p))) {
            const ok = await ask(`"${basename(p)}" already exists in ${target || "the project root"}. Replace it?`, {
              title: "Replace",
              kind: "warning",
              okLabel: "Replace",
            });
            if (!ok) continue;
            await files.trash([dest]);
          }
          await files.rename(p, dest);
          done.push(dest);
        }
        await Promise.all([...new Set([target, ...items.map(dirname)])].map((d) => load(d)));
        if (target) await expand(target);
        if (done.length) {
          setSelection(new Set(done));
          setFocus(done[0]);
        }
      }),
    [act, files, load, expand],
  );

  const remove = useCallback(
    (paths: string[]) =>
      act(async () => {
        if (!paths.length) return;
        const what = paths.length === 1 ? `"${basename(paths[0])}"` : `${paths.length} items`;
        const ok = await ask(`Move ${what} to the Recycle Bin${isHost ? "" : " on the host's computer"}?`, {
          title: "Delete",
          kind: "warning",
          okLabel: "Move to Recycle Bin",
        });
        if (!ok) return;
        await files.trash(paths);
        await Promise.all([...new Set(paths.map(dirname))].map((d) => load(d)));
        setSelection(new Set());
      }),
    [act, files, load, isHost],
  );

  const paste = useCallback(
    (into: string) => {
      if (!clipboard) return;
      const { mode, paths } = clipboard;
      if (mode === "cut") {
        clipboard = null;
        setCut([]);
      }
      void transfer(paths, into, mode === "copy");
    },
    [transfer],
  );

  const setClipboard = (mode: "copy" | "cut", paths: string[]) => {
    if (!paths.length) return;
    clipboard = { mode, paths };
    setCut(mode === "cut" ? paths : []);
  };

  const commitEdit = useCallback(
    async (value: string): Promise<string | null> => {
      const name = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      if (!editing) return null;
      if (!name) return editing.kind === "rename" ? "A name is required." : null;
      if (name.split("/").some((part) => !part || part === "." || part === ".." || INVALID.test(part))) {
        return 'A name cannot contain < > : " | ? * or be "." / "..".';
      }
      if (editing.kind === "rename") {
        const from = editing.path;
        if (name.includes("/")) return "Use drag and drop to move into another folder.";
        if (name === basename(from)) return null;
        const parent = dirname(from);
        if (name.toLowerCase() !== basename(from).toLowerCase() && (await exists(parent, name))) {
          return `"${name}" already exists here.`;
        }
        await act(async () => {
          await files.rename(from, joinPath(parent, name));
          await load(parent);
          const np = joinPath(parent, name);
          setSelection(new Set([np]));
          setFocus(np);
        });
        return null;
      }
      const parent = editing.parent;
      const path = joinPath(parent, name);
      if (await exists(parent, name.split("/")[0]) && !name.includes("/")) return `"${name}" already exists here.`;
      await act(async () => {
        await files.create(path, editing.dir);
        await load(parent);
        await revealPath(path);
        setSelection(new Set([path]));
        setFocus(path);
        if (!editing.dir) onOpen(path);
      });
      return null;
    },
    [editing, act, files, load, revealPath, onOpen],
  );

  const startNew = async (dir: boolean, at: string | null) => {
    const parent = folderOf(at);
    if (parent) await expand(parent);
    setEditing({ kind: "new", parent, dir });
  };

  // --------------------------------------------------------------- clicks ---

  const clickRow = (r: Row, e: React.MouseEvent) => {
    if (r.creating) return;
    bodyRef.current?.focus();
    if (e.shiftKey && anchor && rowIndex.has(anchor)) {
      const [a, b] = [rowIndex.get(anchor)!, rowIndex.get(r.path)!].sort((x, y) => x - y);
      setSelection(new Set(rows.slice(a, b + 1).filter((x) => !x.creating).map((x) => x.path)));
      setFocus(r.path);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      const n = new Set(selection);
      n.has(r.path) ? n.delete(r.path) : n.add(r.path);
      setSelection(n);
      setFocus(r.path);
      setAnchor(r.path);
      return;
    }
    setSelection(new Set([r.path]));
    setFocus(r.path);
    setAnchor(r.path);
    if (r.dir) (expanded.has(r.path) ? collapse(r.path) : void expand(r.path));
    else onOpen(r.path);
  };

  // ------------------------------------------------------- drag (internal) ---

  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const suppressClick = useRef(false);

  /** Folder under a screen point, or "" for empty explorer space, or null outside. */
  const folderAt = useCallback(
    (x: number, y: number): string | null => {
      const body = bodyRef.current;
      if (!body) return null;
      const r = body.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-path]");
      if (!el || !body.contains(el)) return "";
      const p = el.dataset.path!;
      return el.dataset.dir === "1" ? p : dirname(p);
    },
    [],
  );

  const onRowPointerDown = (r: Row, e: React.PointerEvent) => {
    if (e.button !== 0 || r.creating || editing) return;
    const start = { x: e.clientX, y: e.clientY };
    const paths = selection.has(r.path) ? [...selection] : [r.path];
    let started = false;
    let hoverDir: string | null = null;
    let hoverTimer = 0;
    const move = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
      started = true;
      let target = folderAt(ev.clientX, ev.clientY);
      // Not into itself, and moving to the same folder is a no-op (copy is fine).
      if (target != null && paths.some((p) => isInside(target!, p))) target = null;
      if (target != null && !(ev.ctrlKey || ev.altKey) && paths.every((p) => dirname(p) === target)) target = null;
      setDrag({ paths, x: ev.clientX, y: ev.clientY, target, copy: ev.ctrlKey || ev.altKey });
      // Hovering a closed folder opens it, like VS Code.
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-path]");
      const over = el?.dataset.dir === "1" ? el.dataset.path! : null;
      if (over !== hoverDir) {
        hoverDir = over;
        clearTimeout(hoverTimer);
        if (over && !expandedRef.current.has(over)) hoverTimer = window.setTimeout(() => void expand(over), 650);
      }
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      clearTimeout(hoverTimer);
      const d = dragRef.current;
      setDrag(null);
      if (!started) return;
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      if (d?.target != null) void transfer(d.paths, d.target, ev.ctrlKey || ev.altKey);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ------------------------------------------- drop from Windows Explorer ---

  const fileDrag = useFileDrop(
    (paths, x, y) => {
      const target = folderAt(x, y) ?? "";
      void act(async () => {
        const created = await files.importPaths(paths, target);
        await load(target);
        if (target) await expand(target);
        if (created.length) {
          setSelection(new Set(created));
          setFocus(created[0]);
          session.toast(
            `${isHost ? "Copied" : "Uploaded"} ${created.length === 1 ? `"${basename(created[0])}"` : `${created.length} items`} into ${target || session.projectName || "the project"}.`,
          );
        }
      });
    },
    connected,
  );
  const fileDropTarget = fileDrag ? folderAt(fileDrag.x, fileDrag.y) ?? "" : null;

  // ------------------------------------------------------------- keyboard ---

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    const i = focus != null ? rowIndex.get(focus) ?? -1 : -1;
    const r = i >= 0 ? rows[i] : null;
    const moveTo = (j: number) => {
      const t = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (!t || t.creating) return;
      setFocus(t.path);
      if (e.shiftKey && anchor) {
        const [a, b] = [rowIndex.get(anchor) ?? j, j].sort((x, y) => x - y);
        setSelection(new Set(rows.slice(a, b + 1).map((x) => x.path)));
      } else {
        setSelection(new Set([t.path]));
        setAnchor(t.path);
      }
      bodyRef.current?.querySelector(`[data-path="${CSS.escape(t.path)}"]`)?.scrollIntoView({ block: "nearest" });
    };
    const sel = [...selection];
    switch (e.key) {
      case "ArrowDown":
        moveTo(i + 1);
        break;
      case "ArrowUp":
        moveTo(i < 0 ? 0 : i - 1);
        break;
      case "ArrowRight":
        if (r?.dir) expanded.has(r.path) ? moveTo(i + 1) : void expand(r.path);
        break;
      case "ArrowLeft":
        if (r?.dir && expanded.has(r.path)) collapse(r.path);
        else if (r && dirname(r.path)) moveTo(rowIndex.get(dirname(r.path)) ?? i);
        break;
      case "Enter":
        if (r) r.dir ? (expanded.has(r.path) ? collapse(r.path) : void expand(r.path)) : onOpen(r.path);
        break;
      case "F2":
        if (r) setEditing({ kind: "rename", path: r.path });
        break;
      case "Delete":
        void remove(sel);
        break;
      case "Escape":
        setSelection(new Set());
        clipboard = null;
        setCut([]);
        break;
      default:
        if (!(e.ctrlKey || e.metaKey)) return;
        if (e.key === "c") setClipboard("copy", sel);
        else if (e.key === "x") setClipboard("cut", sel);
        else if (e.key === "v") paste(folderOf(focus));
        else if (e.key === "a") setSelection(new Set(rows.filter((x) => !x.creating).map((x) => x.path)));
        else return;
    }
    e.preventDefault();
  };

  // ---------------------------------------------------------- context menu ---

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
    };
  }, []);

  const openMenu = (e: React.MouseEvent, target: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    if (target && !selection.has(target)) {
      setSelection(new Set([target]));
      setAnchor(target);
    }
    if (target) setFocus(target);
    setMenu({ x: e.clientX, y: e.clientY, target });
  };

  const menuItems = (m: Menu) => {
    const t = m.target;
    const sel = t ? (selection.has(t) ? [...selection] : [t]) : [];
    const isDir = t ? rows[rowIndex.get(t) ?? -1]?.dir : true;
    const into = folderOf(t);
    const abs = (p: string) => `${session.projectPath}\\${p.replace(/\//g, "\\")}`;
    const items: ({ label: string; key?: string; run: () => void; disabled?: boolean } | "sep")[] = [
      { label: "New File…", run: () => void startNew(false, t) },
      { label: "New Folder…", run: () => void startNew(true, t) },
    ];
    if (isHost) {
      items.push({ label: "Open in Terminal", run: () => void openTerminalAt(into) });
      items.push({ label: "Reveal in File Explorer", run: () => void revealItemInDir(t ? abs(t) : session.projectPath) });
    }
    items.push("sep");
    if (t) {
      items.push({ label: "Cut", key: "Ctrl+X", run: () => setClipboard("cut", sel) });
      items.push({ label: "Copy", key: "Ctrl+C", run: () => setClipboard("copy", sel) });
    }
    items.push({ label: "Paste", key: "Ctrl+V", run: () => paste(into), disabled: !clipboard });
    if (t) {
      items.push("sep");
      if (isHost) items.push({ label: "Copy Path", run: () => void navigator.clipboard.writeText(sel.map(abs).join("\n")) });
      items.push({ label: "Copy Relative Path", run: () => void navigator.clipboard.writeText(sel.join("\n")) });
      items.push("sep");
      if (sel.length === 1) items.push({ label: "Rename…", key: "F2", run: () => setEditing({ kind: "rename", path: t }) });
      if (!isDir && sel.length === 1) items.push({ label: "Duplicate", run: () => void transfer([t], dirname(t), true) });
      if (!isDir && !isHost) items.push({ label: "Download…", run: () => void act(() => files.download(t)) });
      items.push({ label: sel.length > 1 ? `Delete ${sel.length} Items` : "Delete", key: "Delete", run: () => void remove(sel) });
    }
    return items;
  };

  const openTerminalAt = async (dir: string) => {
    const id = await session.terms.create(dir ? basename(dir) : undefined);
    if (dir) setTimeout(() => session.terms.input(id, `cd "${dir}"\r`), 400);
  };

  const clone = () =>
    act(async () => {
      const where = await files.clone();
      if (where) session.toast(`Cloning into ${where}. Progress is in the Transfers tab.`);
    });

  // ---------------------------------------------------------------- render ---

  const dropTarget = drag ? drag.target : fileDropTarget;
  const inDrop = (r: Row) => dropTarget != null && dropTarget !== "" && isInside(r.path, dropTarget);

  return (
    <div className="pane explorer" data-anchor="explorer" style={{ height: "100%" }}>
      <div className="pane-head">
        <span className="title">{session.projectName || "Explorer"}</span>
        <button className="icon" title="New File…" disabled={!connected} onClick={() => void startNew(false, focus)}>
          <FilePlus size={15} />
        </button>
        <button className="icon" title="New Folder…" disabled={!connected} onClick={() => void startNew(true, focus)}>
          <FolderPlus size={15} />
        </button>
        <button className="icon" title="Refresh" disabled={!connected} onClick={reloadOpen}>
          <RefreshCw size={14} />
        </button>
        <button className="icon" title="Collapse Folders" disabled={!connected} onClick={() => setExpanded(new Set([""]))}>
          <ChevronsDownUp size={15} />
        </button>
        {!isHost && (
          <button className="icon" title="Clone the project to my computer" disabled={!connected} onClick={clone}>
            <Download size={15} />
          </button>
        )}
      </div>
      <div
        ref={bodyRef}
        className={`pane-body tree${dropTarget === "" ? " drop-root" : ""}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => openMenu(e, null)}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            setSelection(new Set());
            setFocus(null);
          }
        }}
      >
        {!connected && !isHost ? (
          <div className="dim" style={{ padding: 14 }}>Waiting for the host…</div>
        ) : !listings.has("") ? (
          <div className="dim" style={{ padding: 14 }}>Loading…</div>
        ) : (
          rows.map((r) =>
            r.creating ? (
              <div key={r.path} className="tree-row editing" style={{ paddingLeft: 8 + r.depth * 12 }}>
                <span className="chev" />
                {r.creating.dir ? <FolderIcon open={false} /> : <FileIcon name="" />}
                <InlineInput initial="" onCommit={commitEdit} onCancel={() => setEditing(null)} onDone={() => setEditing(null)} />
              </div>
            ) : (
              <div
                key={r.path}
                data-path={r.path}
                data-dir={r.dir ? "1" : "0"}
                className={[
                  "tree-row",
                  selection.has(r.path) && "selected",
                  focus === r.path && "focused",
                  activePath === r.path && "active",
                  r.entry?.ignored && "ignored",
                  cut.includes(r.path) && "cut",
                  inDrop(r) && "drop",
                  drag?.paths.includes(r.path) && "dragging",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{ paddingLeft: 8 + r.depth * 12 }}
                title={r.entry?.ignored ? `${r.path}\nNot cloned (ignored / generated / secret)` : r.dir ? r.path : `${r.path}\n${formatBytes(r.entry?.size ?? 0)}`}
                onPointerDown={(e) => onRowPointerDown(r, e)}
                onClick={(e) => !suppressClick.current && clickRow(r, e)}
                onContextMenu={(e) => openMenu(e, r.path)}
              >
                {Array.from({ length: r.depth }, (_, k) => (
                  <span key={k} className="guide" style={{ left: 15 + k * 12 }} />
                ))}
                <span className="chev">
                  {r.dir ? expanded.has(r.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
                </span>
                {r.dir ? <FolderIcon name={r.name} open={expanded.has(r.path)} /> : <FileIcon name={r.name} />}
                {editing?.kind === "rename" && editing.path === r.path ? (
                  <InlineInput
                    initial={r.name}
                    selectStem={!r.dir}
                    onCommit={commitEdit}
                    onCancel={() => setEditing(null)}
                    onDone={() => setEditing(null)}
                  />
                ) : (
                  <span className="name">{r.name}</span>
                )}
                {peerPath && (peerPath === r.path || (r.dir && !expanded.has(r.path) && isInside(peerPath, r.path))) && (
                  <span className="peer-mark" style={{ background: peerColor }} title="Your partner is here" />
                )}
                {!r.dir && (r.entry?.size ?? 0) > 1024 * 1024 && <span className="size">{formatBytes(r.entry!.size)}</span>}
              </div>
            ),
          )
        )}
      </div>

      {drag && (
        <div className="drag-ghost" style={{ left: drag.x + 14, top: drag.y + 10 }}>
          {drag.paths.length === 1 ? basename(drag.paths[0]) : `${drag.paths.length} items`}
          {drag.target == null ? " ⃠" : drag.copy ? " +" : ""}
        </div>
      )}
      {fileDrag && fileDropTarget != null && (
        <div className="drag-ghost" style={{ left: fileDrag.x + 14, top: fileDrag.y + 10 }}>
          {isHost ? "Copy" : "Upload"} into {fileDropTarget || session.projectName || "project"}
        </div>
      )}

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menuItems(menu).map((it, k) =>
            it === "sep" ? (
              <hr key={k} />
            ) : (
              <div
                key={k}
                className={it.disabled ? "disabled" : ""}
                onClick={() => {
                  if (it.disabled) return;
                  setMenu(null);
                  it.run();
                }}
              >
                <span>{it.label}</span>
                {it.key && <span className="key">{it.key}</span>}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** VS Code-style inline name editor with validation. */
function InlineInput(props: {
  initial: string;
  selectStem?: boolean;
  onCommit: (v: string) => Promise<string | null>;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState(props.initial);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const finished = useRef(false);

  useEffect(() => {
    const el = ref.current!;
    el.focus();
    const dot = props.initial.lastIndexOf(".");
    el.setSelectionRange(0, props.selectStem && dot > 0 ? dot : props.initial.length);
  }, [props.initial, props.selectStem]);

  const commit = async (fromBlur: boolean) => {
    if (busy.current || finished.current) return;
    busy.current = true;
    const err = await props.onCommit(value);
    busy.current = false;
    if (err) {
      // On blur an invalid name is just abandoned, like VS Code.
      if (fromBlur) {
        finished.current = true;
        props.onCancel();
      } else setError(err);
      return;
    }
    finished.current = true;
    props.onDone();
  };

  return (
    <span className="inline-edit">
      <input
        ref={ref}
        value={value}
        className={error ? "invalid" : ""}
        spellCheck={false}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") void commit(false);
          if (e.key === "Escape") {
            finished.current = true;
            props.onCancel();
          }
        }}
        onBlur={() => void commit(true)}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      />
      {error && <span className="inline-error">{error}</span>}
    </span>
  );
}
