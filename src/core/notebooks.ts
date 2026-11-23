// Jupyter notebooks.
//
// A notebook lives in the shared Yjs document so both people edit and see it
// live. Layout, under doc.getMap("notebooks"):
//
//   path -> Y.Map {
//     meta:   string                 JSON of { metadata, nbformat, nbformat_minor }
//     cells:  Y.Array<Y.Map>         each cell:
//               id, type ("code"|"markdown"|"raw"), source: Y.Text,
//               outputs: Y.Array<nbformat output>, exec: number|null,
//               state: "idle"|"queued"|"running", meta: object
//     kernel: KernelInfo             status shown to both sides
//   }
//
// Only the host reads and writes the .ipynb file and runs kernels (a real
// ipykernel through src-tauri/resources/duet_kernel.py). The guest asks the
// host over RPC to run cells, interrupt, restart and complete.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as Y from "yjs";
import { waitForKey } from "./files";
import type { Session } from "./session";
import { Emitter, randomString } from "./util";

export type CellType = "code" | "markdown" | "raw";
export type CellState = "idle" | "queued" | "running";

export interface KernelInfo {
  state: "off" | "starting" | "idle" | "busy" | "restarting" | "dead" | "missing";
  python?: string;
  python_version?: string;
  message?: string;
}

export interface CompleteReply {
  matches: string[];
  cursor_start: number;
  cursor_end: number;
  metadata?: { _jupyter_types_experimental?: { text: string; type: string; signature?: string }[] };
}

const SAVE_DELAY_MS = 700;
const MAX_STREAM_CHARS = 400_000;
const MAX_DATA_BYTES = 8 * 1024 * 1024;

type Events = { kernel: { path: string; info: KernelInfo } };

interface Kernel {
  id: string;
  ready: Promise<void>;
  requests: Map<number, { onIopub?: (type: string, c: any) => void; onReply: (type: string, c: any) => void }>;
  queue: string[]; // cell ids waiting to run
  running: string | null;
  nextReq: number;
}

/** Notebooks of the active session, for the cell completion provider. */
export let activeNotebooks: Notebooks | null = null;

export class Notebooks extends Emitter<Events> {
  private kernels = new Map<string, Kernel>();
  private lastSaved = new Map<string, string>();
  private saveTimers = new Map<string, number>();
  private loading = new Map<string, Promise<void>>();
  private python: Promise<string> | null = null;
  private offs: (() => void)[] = [];
  private disposed = false;

  constructor(private s: Session) {
    super();
    activeNotebooks = this;
    if (s.role === "host") this.setupHost();
  }

  get map(): Y.Map<Y.Map<any>> {
    return this.s.doc.getMap("notebooks");
  }

  nb(path: string) {
    return this.map.get(path) ?? null;
  }

  cells(path: string): Y.Array<Y.Map<any>> | null {
    return (this.nb(path)?.get("cells") as Y.Array<Y.Map<any>>) ?? null;
  }

  // ------------------------------------------------------- shared editing ---
  // Plain Yjs edits: both sides make them directly, the CRDT merges them.

  insertCell(path: string, index: number, type: CellType = "code", source = ""): string {
    const cells = this.cells(path);
    if (!cells) return "";
    const c = makeCell({ cell_type: type, source, id: randomString(8, "abcdef0123456789") });
    this.s.doc.transact(() => cells.insert(Math.max(0, Math.min(index, cells.length)), [c]));
    return c.get("id");
  }

  deleteCell(path: string, id: string) {
    const cells = this.cells(path);
    const i = indexOf(cells, id);
    if (cells && i >= 0) this.s.doc.transact(() => cells.delete(i, 1));
  }

  /** Move by +1/-1. Y types cannot be moved, so the cell is copied. */
  moveCell(path: string, id: string, delta: number) {
    const cells = this.cells(path);
    const i = indexOf(cells, id);
    const j = i + delta;
    if (!cells || i < 0 || j < 0 || j >= cells.length) return;
    this.s.doc.transact(() => {
      const copy = makeCell(cellToJson(cells.get(i)));
      copy.set("state", cells.get(i).get("state"));
      cells.delete(i, 1);
      cells.insert(j, [copy]);
    });
  }

  setType(path: string, id: string, type: CellType) {
    const c = this.cell(path, id);
    if (!c || c.get("type") === type) return;
    this.s.doc.transact(() => {
      c.set("type", type);
      if (type !== "code") {
        (c.get("outputs") as Y.Array<any>).delete(0, (c.get("outputs") as Y.Array<any>).length);
        c.set("exec", null);
      }
    });
  }

  clearOutputs(path: string, ids?: string[]) {
    const cells = this.cells(path);
    if (!cells) return;
    this.s.doc.transact(() => {
      for (const c of cells) {
        if (ids && !ids.includes(c.get("id"))) continue;
        const o = c.get("outputs") as Y.Array<any>;
        if (o.length) o.delete(0, o.length);
        if (!ids) c.set("exec", null);
      }
    });
  }

  cell(path: string, id: string) {
    const cells = this.cells(path);
    const i = indexOf(cells, id);
    return i >= 0 ? cells!.get(i) : null;
  }

  // ------------------------------------------------------------ actions ---

  /** Host: load into the shared document. Guest: ask the host to. */
  async open(path: string): Promise<void> {
    if (this.map.has(path)) return;
    if (this.s.role === "host") return this.load(path);
    await this.s.rpc.call("nb.open", { path });
    await this.waitFor(path);
  }

  run(path: string, ids: string[]): Promise<void> {
    if (this.s.role === "guest") return this.s.rpc.call("nb.run", { path, ids });
    return this.hostRun(path, ids);
  }

  interrupt(path: string): Promise<void> {
    if (this.s.role === "guest") return this.s.rpc.call("nb.interrupt", { path });
    return this.hostInterrupt(path);
  }

  restart(path: string): Promise<void> {
    if (this.s.role === "guest") return this.s.rpc.call("nb.restart", { path });
    return this.hostRestart(path);
  }

  complete(path: string, code: string, cursor: number): Promise<CompleteReply | null> {
    if (this.s.role === "guest") return this.s.rpc.call("nb.complete", { path, code, cursor }, 8000).catch(() => null);
    return this.hostComplete(path, code, cursor);
  }

  /** Python the kernel would use (project venv first). */
  kernelPython() {
    return this.findPython();
  }

  dispose() {
    this.disposed = true;
    if (activeNotebooks === this) activeNotebooks = null;
    this.offs.forEach((f) => f());
    for (const [, k] of this.kernels) void invoke("kernel_stop", { id: k.id });
    this.kernels.clear();
  }

  private waitFor(path: string): Promise<void> {
    return waitForKey(() => this.map, path, () => this.s.ysync.resync(), "notebook did not arrive");
  }

  // ------------------------------------------------------------------ host ---

  private setupHost() {
    const rpc = this.s.rpc;
    const allowed = () => {
      if (!this.s.perms.terminal) throw new Error("The host has not allowed you to run code.");
    };
    rpc.handle("nb.open", ({ path }) => this.load(path));
    rpc.handle("nb.run", ({ path, ids }) => (allowed(), this.hostRun(path, ids)));
    rpc.handle("nb.interrupt", ({ path }) => (allowed(), this.hostInterrupt(path)));
    rpc.handle("nb.restart", ({ path }) => (allowed(), this.hostRestart(path)));
    rpc.handle("nb.complete", ({ path, code, cursor }) => this.hostComplete(path, code, cursor));

    const map = this.map;
    const onDeep = (events: Y.YEvent<any>[], tr: Y.Transaction) => {
      if (tr.origin === "load" || tr.origin === "disk") return;
      const paths = new Set<string>();
      for (const ev of events) {
        const key = ev.path[0];
        if (typeof key === "string") paths.add(key);
        else if (ev.target === map) (ev as Y.YMapEvent<any>).keysChanged.forEach((k) => paths.add(k));
      }
      for (const p of paths) if (map.has(p)) this.scheduleSave(p);
    };
    map.observeDeep(onDeep);
    this.offs.push(() => map.unobserveDeep(onDeep));

    void listen<{ path: string; exists: boolean }[]>("fs-changed", (e) => void this.onDisk(e.payload)).then((un) =>
      this.disposed ? un() : this.offs.push(un),
    );
    void listen<{ id: string }>("kernel-exit", (e) => {
      for (const [path, k] of this.kernels) {
        if (k.id !== e.payload.id) continue;
        this.kernels.delete(path);
        this.endQueue(path, k);
        const cur = this.nb(path)?.get("kernel") as KernelInfo | undefined;
        if (cur && cur.state !== "missing") this.setKernel(path, { ...cur, state: "dead" });
      }
    }).then((un) => (this.disposed ? un() : this.offs.push(un)));
    // A renamed or deleted notebook loses its kernel; the editor reopens it.
    this.offs.push(
      this.s.files.on("renamed", ({ from }) => {
        for (const p of [...this.map.keys()]) if (p === from || p.startsWith(from + "/")) this.forget(p);
      }),
    );
  }

  /** Drop a notebook from the shared document (renamed / deleted on disk). */
  forget(path: string) {
    const k = this.kernels.get(path);
    if (k) void invoke("kernel_stop", { id: k.id });
    this.kernels.delete(path);
    clearTimeout(this.saveTimers.get(path));
    this.saveTimers.delete(path);
    if (this.map.has(path)) this.s.doc.transact(() => this.map.delete(path), "disk");
  }

  private load(path: string): Promise<void> {
    if (this.map.has(path)) return Promise.resolve();
    let p = this.loading.get(path);
    if (!p) {
      p = (async () => {
        const bytes = new Uint8Array(await invoke<ArrayBuffer>("fs_read", { rel: path }));
        const text = new TextDecoder().decode(bytes);
        const json = parseNotebook(text);
        if (this.map.has(path)) return;
        this.s.doc.transact(() => this.map.set(path, buildNotebook(json)), "load");
        this.lastSaved.set(path, text.trim() ? text : "");
        if (!text.trim()) this.scheduleSave(path); // new empty file: write a real notebook
      })().finally(() => this.loading.delete(path));
      this.loading.set(path, p);
    }
    return p;
  }

  private scheduleSave(path: string) {
    clearTimeout(this.saveTimers.get(path));
    this.saveTimers.set(path, window.setTimeout(() => void this.save(path), SAVE_DELAY_MS));
  }

  private async save(path: string) {
    this.saveTimers.delete(path);
    const nb = this.nb(path);
    if (!nb) return;
    const text = serializeNotebook(nb);
    if (text === this.lastSaved.get(path)) return;
    this.lastSaved.set(path, text);
    try {
      await invoke("fs_write_text", { rel: path, text });
    } catch (e) {
      this.lastSaved.delete(path);
      this.s.toast(`Could not save ${path}: ${e}`);
    }
  }

  /** Flush pending saves (session end). */
  async flush() {
    const paths = [...this.saveTimers.keys()];
    paths.forEach((p) => clearTimeout(this.saveTimers.get(p)));
    await Promise.all(paths.map((p) => this.save(p)));
  }

  private async onDisk(changes: { path: string; exists: boolean }[]) {
    for (const c of changes) {
      if (!this.map.has(c.path)) continue;
      if (!c.exists) {
        setTimeout(() => this.map.has(c.path) && this.forget(c.path), 300);
        continue;
      }
      if (this.saveTimers.has(c.path)) continue; // our edits win, they are saved shortly
      try {
        const text = new TextDecoder().decode(new Uint8Array(await invoke<ArrayBuffer>("fs_read", { rel: c.path })));
        if (text === this.lastSaved.get(c.path)) continue;
        const json = parseNotebook(text);
        this.lastSaved.set(c.path, text);
        // Changed outside Duet (e.g. Jupyter, git): take the file as it is now.
        this.s.doc.transact(() => {
          const nb = this.nb(c.path)!;
          const cells = nb.get("cells") as Y.Array<Y.Map<any>>;
          cells.delete(0, cells.length);
          cells.insert(0, json.cells.map(makeCell));
          nb.set("meta", JSON.stringify({ metadata: json.metadata, nbformat: json.nbformat, nbformat_minor: json.nbformat_minor }));
        }, "disk");
      } catch {
        /* half-written file; the next event will catch it */
      }
    }
  }

  private findPython(): Promise<string> {
    this.python ??= (async () => {
      const win = navigator.userAgent.includes("Windows");
      for (const v of [".venv", "venv", "env"]) {
        const rel = win ? `${v}/Scripts/python.exe` : `${v}/bin/python`;
        try {
          await invoke("fs_stat", { rel });
          return win ? `${this.s.projectPath}\\${v}\\Scripts\\python.exe` : `${this.s.projectPath}/${rel}`;
        } catch {
          /* not this one */
        }
      }
      return win ? "python" : "python3";
    })();
    return this.python;
  }

  private setKernel(path: string, info: KernelInfo) {
    const nb = this.nb(path);
    if (nb) this.s.doc.transact(() => nb.set("kernel", info), "kernel");
    this.emit("kernel", { path, info });
  }

  private ensureKernel(path: string): Kernel {
    let k = this.kernels.get(path);
    if (k) return k;
    const id = `nb-${randomString(8)}`;
    const kernel: Kernel = { id, ready: Promise.resolve(), requests: new Map(), queue: [], running: null, nextReq: 1 };
    kernel.ready = new Promise<void>((resolve, reject) => {
      const ch = new Channel<ArrayBuffer>();
      const dec = new TextDecoder();
      let started = false;
      ch.onmessage = (buf) => {
        let m: any;
        try {
          m = JSON.parse(dec.decode(buf));
        } catch {
          return;
        }
        if (m.ev === "status") {
          const cur = (this.nb(path)?.get("kernel") as KernelInfo) ?? { state: "off" };
          const info: KernelInfo = { ...cur, state: m.state, python: m.python ?? cur.python, python_version: m.python_version ?? cur.python_version, message: m.message };
          this.setKernel(path, info);
          if (!started && m.state === "idle") {
            started = true;
            resolve();
          }
          if (m.state === "missing" || (m.state === "dead" && !started)) reject(new Error(m.message ?? "kernel unavailable"));
        } else if (m.ev === "iopub") kernel.requests.get(m.id)?.onIopub?.(m.type, m.content);
        else if (m.ev === "reply") {
          const r = kernel.requests.get(m.id);
          kernel.requests.delete(m.id);
          r?.onReply(m.type, m.content);
        } else if (m.ev === "error") console.warn("kernel bridge:", m.message);
      };
      this.setKernel(path, { state: "starting" });
      void this.findPython()
        .then((python) => invoke("kernel_start", { id, python, cwd: this.s.projectPath, onMsg: ch }))
        .catch((e) => {
          this.setKernel(path, { state: "missing", message: String(e) });
          reject(e);
        });
    });
    kernel.ready.catch(() => {
      if (this.kernels.get(path) === kernel) this.kernels.delete(path);
    });
    this.kernels.set(path, kernel);
    return kernel;
  }

  private send(k: Kernel, op: Record<string, unknown>) {
    return invoke("kernel_send", { id: k.id, msg: JSON.stringify(op) });
  }

  private request(k: Kernel, op: Record<string, unknown>, onIopub?: (t: string, c: any) => void): Promise<{ type: string; content: any }> {
    const id = k.nextReq++;
    return new Promise((res, rej) => {
      k.requests.set(id, { onIopub, onReply: (type, content) => res({ type, content }) });
      this.send(k, { ...op, id }).catch((e) => {
        k.requests.delete(id);
        rej(e);
      });
    });
  }

  private async hostRun(path: string, ids: string[]) {
    await this.load(path);
    const k = this.ensureKernel(path);
    this.s.doc.transact(() => {
      for (const id of ids) {
        const c = this.cell(path, id);
        if (!c || c.get("type") !== "code" || k.queue.includes(id) || k.running === id) continue;
        c.set("state", "queued");
        k.queue.push(id);
      }
    }, "kernel");
    void this.pump(path, k);
  }

  private async pump(path: string, k: Kernel) {
    if (k.running || !k.queue.length) return;
    try {
      await k.ready;
    } catch {
      this.endQueue(path, k);
      return;
    }
    const id = k.queue.shift()!;
    const c = this.cell(path, id);
    if (!c) return void this.pump(path, k);
    k.running = id;
    let clearPending = false;
    this.s.doc.transact(() => {
      c.set("state", "running");
      const o = c.get("outputs") as Y.Array<any>;
      if (o.length) o.delete(0, o.length);
    }, "kernel");
    const code = (c.get("source") as Y.Text).toString();
    try {
      const reply = await this.request(k, { op: "execute", code }, (type, content) => {
        const cell = this.cell(path, id);
        if (!cell) return;
        const outputs = cell.get("outputs") as Y.Array<any>;
        if (type === "clear_output") {
          if (content.wait) clearPending = true;
          else this.s.doc.transact(() => outputs.delete(0, outputs.length), "kernel");
          return;
        }
        const out = toOutput(type, content);
        if (!out) return;
        this.s.doc.transact(() => {
          if (clearPending) {
            outputs.delete(0, outputs.length);
            clearPending = false;
          }
          appendOutput(outputs, out);
        }, "kernel");
      });
      const cell = this.cell(path, id);
      if (cell) this.s.doc.transact(() => {
        cell.set("exec", reply.content.execution_count ?? null);
        cell.set("state", "idle");
      }, "kernel");
      // Like Jupyter's "run all": stop at the first error.
      if (reply.content.status === "error") this.endQueue(path, k);
    } catch {
      this.endQueue(path, k);
    } finally {
      k.running = null;
      const cell = this.cell(path, id);
      if (cell && cell.get("state") === "running") cell.set("state", "idle");
    }
    void this.pump(path, k);
  }

  /** Mark queued (and running) cells idle and forget the queue. */
  private endQueue(path: string, k: Kernel) {
    const ids = [...k.queue, ...(k.running ? [k.running] : [])];
    k.queue = [];
    this.s.doc.transact(() => {
      for (const id of ids) this.cell(path, id)?.set("state", "idle");
    }, "kernel");
  }

  private async hostInterrupt(path: string) {
    const k = this.kernels.get(path);
    if (!k) return;
    const running = k.running;
    k.queue.forEach((id) => this.cell(path, id)?.set("state", "idle"));
    k.queue = [];
    await this.send(k, { op: "interrupt" });
    if (running) this.cell(path, running); // the reply (KeyboardInterrupt) finishes it
  }

  private async hostRestart(path: string) {
    const k = this.kernels.get(path);
    if (!k) {
      // Not running (or ipykernel was just installed): start fresh.
      const cur = this.nb(path)?.get("kernel") as KernelInfo | undefined;
      if (cur?.state === "missing" || cur?.state === "dead") this.python = null;
      await this.ensureKernel(path).ready.catch(() => {});
      return;
    }
    this.endQueue(path, k);
    k.requests.clear();
    await this.send(k, { op: "restart" });
  }

  private async hostComplete(path: string, code: string, cursor: number): Promise<CompleteReply | null> {
    const k = this.kernels.get(path);
    if (!k) return null; // completion never starts a kernel by itself
    try {
      await k.ready;
      const r = await Promise.race([
        this.request(k, { op: "complete", code, cursor }),
        new Promise<null>((res) => setTimeout(() => res(null), 4000)),
      ]);
      return r ? (r.content as CompleteReply) : null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------- nbformat ---

interface NbJson {
  cells: any[];
  metadata: any;
  nbformat: number;
  nbformat_minor: number;
}

export function parseNotebook(text: string): NbJson {
  if (!text.trim()) {
    return {
      cells: [{ cell_type: "code", source: "", metadata: {}, outputs: [], execution_count: null }],
      metadata: {
        kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
        language_info: { name: "python" },
      },
      nbformat: 4,
      nbformat_minor: 5,
    };
  }
  const j = JSON.parse(text);
  if (!j || !Array.isArray(j.cells)) throw new Error("Not a Jupyter notebook (nbformat 4).");
  return { cells: j.cells, metadata: j.metadata ?? {}, nbformat: j.nbformat ?? 4, nbformat_minor: j.nbformat_minor ?? 5 };
}

const joinSource = (s: unknown) => (Array.isArray(s) ? s.join("") : typeof s === "string" ? s : "");

export function makeCell(c: any): Y.Map<any> {
  const m = new Y.Map<any>();
  const src = new Y.Text();
  src.insert(0, joinSource(c.source).replace(/\r\n/g, "\n"));
  const outputs = new Y.Array<any>();
  if (c.cell_type === "code" && Array.isArray(c.outputs)) outputs.insert(0, c.outputs);
  m.set("id", typeof c.id === "string" && c.id ? c.id : randomString(8, "abcdef0123456789"));
  m.set("type", c.cell_type === "markdown" || c.cell_type === "raw" ? c.cell_type : "code");
  m.set("source", src);
  m.set("outputs", outputs);
  m.set("exec", c.cell_type === "code" ? (c.execution_count ?? null) : null);
  m.set("state", "idle");
  m.set("meta", c.metadata ?? {});
  if (c.attachments) m.set("attachments", c.attachments);
  return m;
}

function buildNotebook(j: NbJson): Y.Map<any> {
  const nb = new Y.Map<any>();
  const cells = new Y.Array<Y.Map<any>>();
  cells.insert(0, j.cells.map(makeCell));
  nb.set("cells", cells);
  nb.set("meta", JSON.stringify({ metadata: j.metadata, nbformat: j.nbformat, nbformat_minor: j.nbformat_minor }));
  nb.set("kernel", { state: "off" } satisfies KernelInfo);
  return nb;
}

/** Jupyter stores source as a list of lines, each keeping its "\n". */
const splitLines = (s: string) => (s ? s.match(/[^\n]*\n|[^\n]+$/g) ?? [] : []);

export function cellToJson(c: Y.Map<any>): any {
  const type = c.get("type") as CellType;
  const out: any = { cell_type: type, id: c.get("id"), metadata: c.get("meta") ?? {}, source: splitLines((c.get("source") as Y.Text).toString()) };
  if (c.get("attachments")) out.attachments = c.get("attachments");
  if (type === "code") {
    out.execution_count = c.get("exec") ?? null;
    out.outputs = (c.get("outputs") as Y.Array<any>).toArray();
  }
  return out;
}

export function serializeNotebook(nb: Y.Map<any>): string {
  const meta = JSON.parse((nb.get("meta") as string) || "{}");
  const cells = (nb.get("cells") as Y.Array<Y.Map<any>>).toArray().map(cellToJson);
  const doc = { cells, metadata: meta.metadata ?? {}, nbformat: meta.nbformat ?? 4, nbformat_minor: Math.max(meta.nbformat_minor ?? 5, 5) };
  return JSON.stringify(doc, null, 1) + "\n";
}

function indexOf(cells: Y.Array<Y.Map<any>> | null, id: string) {
  if (!cells) return -1;
  for (let i = 0; i < cells.length; i++) if (cells.get(i).get("id") === id) return i;
  return -1;
}

/** Kernel iopub message -> nbformat output (or null to ignore). */
function toOutput(type: string, c: any): any | null {
  switch (type) {
    case "stream":
      return { output_type: "stream", name: c.name, text: c.text };
    case "display_data":
    case "execute_result": {
      let size = 0;
      for (const v of Object.values(c.data ?? {})) size += typeof v === "string" ? v.length : JSON.stringify(v).length;
      if (size > MAX_DATA_BYTES) {
        return { output_type: "stream", name: "stderr", text: `[output of ${Math.round(size / 1e6)} MB not shown: too large to share live]\n` };
      }
      const o: any = { output_type: type, data: c.data ?? {}, metadata: c.metadata ?? {} };
      if (type === "execute_result") o.execution_count = c.execution_count ?? null;
      return o;
    }
    case "error":
      return { output_type: "error", ename: c.ename, evalue: c.evalue, traceback: c.traceback ?? [] };
    default:
      return null;
  }
}

/** Consecutive stream chunks of the same name are merged, as in Jupyter. */
function appendOutput(outputs: Y.Array<any>, out: any) {
  const last = outputs.length ? outputs.get(outputs.length - 1) : null;
  if (out.output_type === "stream" && last?.output_type === "stream" && last.name === out.name) {
    let text = last.text + out.text;
    if (text.length > MAX_STREAM_CHARS) text = "[… earlier output trimmed …]\n" + text.slice(-MAX_STREAM_CHARS);
    outputs.delete(outputs.length - 1, 1);
    outputs.push([{ ...last, text }]);
  } else outputs.push([out]);
}
