// Project files.
//
// The project lives only on the host's disk. The guest sees names (listed
// lazily, one folder at a time) and receives content only for what it opens:
//   - text files become a Y.Text in doc.getMap("files") and are edited live;
//     only the host writes them back to disk;
//   - binary / very large files are streamed over the bulk lane on request
//     and cached by hash on the guest;
//   - "Clone" copies the whole project (minus .env, node_modules, .venv, ...)
//     into a folder the guest picks.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as Y from "yjs";
import { Kind, type Frame } from "../net/bulk";
import { cacheGet, cachePut } from "./cache";
import type { Session } from "./session";
import { Emitter, basename, dirname, formatBytes, headerSafe } from "./util";

export interface FsEntry {
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
  ignored: boolean;
}

export type OpenResult =
  | { kind: "text" }
  | { kind: "notebook" }
  | { kind: "binary"; size: number; hash: string }
  | { kind: "large"; size: number; hash: string };

export interface Transfer {
  id: number;
  label: string;
  done: number;
  total: number;
  state: "running" | "done" | "error" | "cancelled";
  error?: string;
}

interface Stat {
  size: number;
  mtime: number;
  hash: string;
}

/** Text files above this are not put into the live document. */
export const MAX_LIVE_TEXT = 2 * 1024 * 1024;
const READ_CHUNK = 512 * 1024;
const SAVE_DELAY_MS = 300;

type Events = {
  /** Folders whose listing changed. "" is the root. */
  changed: string[];
  renamed: { from: string; to: string };
  transfers: Transfer[];
};

interface Sink {
  onData(chunk: Uint8Array, offset: number): Promise<unknown> | void;
  resolve(): void;
  reject(e: Error): void;
  received: number;
  queue: Promise<void>;
}

export class Files extends Emitter<Events> {
  transfers: Transfer[] = [];
  private nextStream = 1 << 20;
  private nextTransfer = 1;
  private sinks = new Map<number, Sink>();
  private cancelled = new Set<number>();
  // host only
  private format = new Map<string, { crlf: boolean; bom: boolean }>();
  private lastSaved = new Map<string, string>();
  private saveTimers = new Map<string, number>();
  private opening = new Map<string, Promise<OpenResult>>();
  private uploads = new Map<number, Promise<void>>();

  constructor(private s: Session) {
    super();
    s.bulk.on("frame", (f) => this.onFrame(f));
    s.bulk.on("reset", () => {
      for (const [, sink] of this.sinks) sink.reject(new Error("connection lost"));
      this.sinks.clear();
    });
    if (s.role === "host") this.setupHost();
    else {
      s.rpc.on("fs.changed", (dirs: string[]) => this.emit("changed", dirs));
      s.rpc.on("fs.renamed", (r: { from: string; to: string }) => this.emit("renamed", r));
    }
  }

  get map(): Y.Map<Y.Text> {
    return this.s.doc.getMap<Y.Text>("files");
  }

  // ------------------------------------------------------------ common API ---

  list(dir: string): Promise<FsEntry[]> {
    return this.s.role === "host" ? invoke("fs_list", { rel: dir }) : this.s.rpc.call("fs.list", { dir });
  }

  async open(path: string): Promise<OpenResult> {
    if (this.map.has(path)) return { kind: "text" };
    if (this.s.role === "host") return this.hostOpen(path);
    const r = await this.s.rpc.call<OpenResult>("fs.open", { path });
    if (r.kind === "text") await this.waitForText(path);
    if (r.kind === "notebook") await this.s.notebooks.open(path);
    return r;
  }

  create(path: string, dir: boolean): Promise<void> {
    return this.s.role === "host" ? invoke("fs_create", { rel: path, dir }) : this.s.rpc.call("fs.create", { path, dir });
  }

  remove(path: string): Promise<void> {
    return this.s.role === "host" ? this.hostRemove(path) : this.s.rpc.call("fs.delete", { path });
  }

  rename(from: string, to: string): Promise<void> {
    return this.s.role === "host" ? this.hostRename(from, to) : this.s.rpc.call("fs.rename", { from, to });
  }

  /** Copy inside the project; a taken name becomes "name copy.ext". Returns the new path. */
  copy(from: string, to: string): Promise<string> {
    return this.s.role === "host" ? invoke("fs_copy", { from, to }) : this.s.rpc.call("fs.copy", { from, to });
  }

  /** Move to the Recycle Bin on the host (recoverable). */
  trash(paths: string[]): Promise<void> {
    return this.s.role === "host" ? this.hostTrash(paths) : this.s.rpc.call("fs.trash", { paths });
  }

  /**
   * Files/folders dropped from Windows Explorer into project folder `dir`.
   * Host: copied directly. Guest: uploaded to the host over the bulk lane.
   * Returns the top-level project paths created.
   */
  async importPaths(sources: string[], dir: string): Promise<string[]> {
    if (this.s.role === "host") return invoke<string[]>("fs_import", { sources, dir });
    return this.upload(sources, dir);
  }

  private async upload(sources: string[], dir: string): Promise<string[]> {
    const items = await invoke<{ abs: string; rel: string; size: number; dir: boolean }[]>("local_walk", { paths: sources });
    if (!items.length) return [];
    // Top-level names may be taken on the host: pick free ones, then rewrite children.
    const tops = new Map<string, string>();
    for (const it of items) {
      const top = it.rel.split("/")[0];
      if (!tops.has(top)) tops.set(top, await this.s.rpc.call<string>("fs.unique", { rel: dir ? `${dir}/${top}` : top }));
    }
    const target = (rel: string) => {
      const [top, ...rest] = rel.split("/");
      return [tops.get(top)!, ...rest].join("/");
    };
    const files = items.filter((i) => !i.dir);
    const total = files.reduce((a, b) => a + b.size, 0);
    const t = this.addTransfer(`Upload ${files.length} file${files.length === 1 ? "" : "s"} (${formatBytes(total)})`, total);
    let base = 0;
    try {
      for (const it of items.filter((i) => i.dir)) await this.s.rpc.call("fs.create", { path: target(it.rel), dir: true }).catch(() => {});
      for (const f of files) {
        if (isCancelled(t)) break;
        const stream = this.nextStream++;
        await this.s.rpc.call("fs.uploadOpen", { path: target(f.rel), stream });
        for (let off = 0; off < f.size; ) {
          if (isCancelled(t)) break;
          await this.s.bulk.waitQueued(stream, 2 * READ_CHUNK);
          const chunk = new Uint8Array(await invoke<ArrayBuffer>("local_read_range", { path: f.abs, offset: off, len: READ_CHUNK }));
          if (!chunk.length) break;
          this.s.bulk.send(Kind.FileData, stream, chunk);
          off += chunk.length;
          t.done = base + off;
          this.emitTransfers();
        }
        this.s.bulk.send(isCancelled(t) ? Kind.FileErr : Kind.FileEnd, stream);
        await this.s.rpc.call("fs.uploadWait", { stream }, 10 * 60_000);
        base += f.size;
      }
      if (t.state === "running") {
        t.state = "done";
        t.done = total;
      }
    } catch (e) {
      t.state = "error";
      t.error = String(e);
      throw e;
    } finally {
      this.emitTransfers();
    }
    return [...tops.values()];
  }

  /** Whole file as bytes (images, read-only view of large files). */
  async readBytes(path: string, info?: { hash: string }): Promise<Uint8Array> {
    if (this.s.role === "host") return new Uint8Array(await invoke<ArrayBuffer>("fs_read", { rel: path }));
    const key = `${this.s.projectKey}:${path}`;
    if (info) {
      const hit = await cacheGet(key, info.hash);
      if (hit) return hit;
    }
    const parts: Uint8Array[] = [];
    let size = 0;
    const meta = await this.fetch(path, basename(path), {
      onData: (c) => {
        parts.push(c);
        size += c.length;
      },
    });
    const out = new Uint8Array(size);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    if (meta.hash) void cachePut(key, meta.hash, out);
    return out;
  }

  /** Guest: save one project file to a location chosen in a dialog. */
  async download(path: string) {
    const target = await saveDialog({ defaultPath: basename(path) });
    if (!target) return;
    const root = dirname(target.replace(/\\/g, "/"));
    const name = basename(target.replace(/\\/g, "/"));
    await this.fetch(path, `Download ${basename(path)}`, {
      onData: (c, offset) => this.localWrite(root, name, c, offset),
      emptyFile: () => this.localWrite(root, name, new Uint8Array(0), 0),
    });
  }

  /** Guest: copy the project into a folder the guest picks. */
  async clone(): Promise<string | null> {
    const picked = await openDialog({ directory: true, title: "Choose a folder to clone the project into" });
    if (!picked || Array.isArray(picked)) return null;
    const root = `${picked.replace(/\\/g, "/")}/${this.s.projectName || "project"}`;
    const items = await this.s.rpc.call<{ path: string; size: number }[]>("clone.list");
    const total = items.reduce((a, b) => a + b.size, 0);
    const t = this.addTransfer(`Clone ${items.length} files (${formatBytes(total)})`, total);
    let base = 0;
    try {
      for (const it of items) {
        if (t.state === "cancelled") break;
        await this.fetch(
          it.path,
          null,
          {
            onData: async (c, offset) => {
              await this.localWrite(root, it.path, c, offset);
              t.done = base + offset + c.length;
              this.emitTransfers();
            },
            emptyFile: () => this.localWrite(root, it.path, new Uint8Array(0), 0),
          },
          t,
        );
        base += it.size;
        t.done = base;
      }
      if (t.state === "running") t.state = "done";
    } catch (e) {
      t.state = "error";
      t.error = String(e);
    }
    this.emitTransfers();
    return root;
  }

  cancelTransfer(id: number) {
    const t = this.transfers.find((x) => x.id === id);
    if (t && t.state === "running") {
      t.state = "cancelled";
      this.emitTransfers();
    }
  }

  // ------------------------------------------------------- guest transfers ---

  private localWrite(root: string, rel: string, data: Uint8Array, offset: number) {
    return invoke("local_write", data, {
      headers: { "x-root": headerSafe(root), "x-rel": headerSafe(rel), "x-offset": String(offset) },
    });
  }

  private addTransfer(label: string, total: number): Transfer {
    const t: Transfer = { id: this.nextTransfer++, label, done: 0, total, state: "running" };
    this.transfers = [t, ...this.transfers].slice(0, 20);
    this.emitTransfers();
    return t;
  }

  private emitTransfers() {
    this.emit("transfers", [...this.transfers]);
  }

  /**
   * Stream a file from the host over the bulk lane. `label` null = part of an
   * outer transfer (`parent`), otherwise a transfer entry of its own.
   */
  private async fetch(
    path: string,
    label: string | null,
    sink: { onData: (c: Uint8Array, offset: number) => Promise<unknown> | void; emptyFile?: () => Promise<unknown> },
    parent?: Transfer,
  ): Promise<{ size: number; hash?: string }> {
    const stream = this.nextStream++;
    const done = new Promise<void>((resolve, reject) => {
      this.sinks.set(stream, { onData: sink.onData, resolve, reject, received: 0, queue: Promise.resolve() });
    });
    let meta: { size: number; hash?: string };
    try {
      meta = await this.s.rpc.call("fs.fetch", { path, stream });
    } catch (e) {
      this.sinks.delete(stream);
      throw e;
    }
    const own = label ? this.addTransfer(label, meta.size) : null;
    const t = parent ?? own;
    const watch = window.setInterval(() => {
      if (own) {
        own.done = this.sinks.get(stream)?.received ?? own.done;
        this.emitTransfers();
      }
      if (t?.state === "cancelled") {
        void this.s.rpc.call("fs.cancel", { stream }).catch(() => {});
        this.sinks.get(stream)?.reject(new Error("cancelled"));
        this.sinks.delete(stream);
      }
    }, 250);
    try {
      await done;
      if (meta.size === 0) await sink.emptyFile?.();
      if (own) {
        own.done = own.total;
        own.state = "done";
      }
    } catch (e) {
      if (own && own.state === "running") {
        own.state = "error";
        own.error = String(e);
      }
      throw e;
    } finally {
      clearInterval(watch);
      if (own) this.emitTransfers();
    }
    return meta;
  }

  private onFrame(f: Frame) {
    if (f.kind !== Kind.FileData && f.kind !== Kind.FileEnd && f.kind !== Kind.FileErr) return;
    const sink = this.sinks.get(f.stream);
    if (!sink) return;
    if (f.kind === Kind.FileData) {
      const chunk = f.payload.slice();
      const offset = sink.received;
      sink.received += chunk.length;
      sink.queue = sink.queue.then(async () => void (await sink.onData(chunk, offset)));
      sink.queue.catch((e) => {
        sink.reject(e);
        this.sinks.delete(f.stream);
      });
    } else {
      this.sinks.delete(f.stream);
      if (f.kind === Kind.FileEnd) sink.queue.then(sink.resolve, sink.reject);
      else sink.reject(new Error(new TextDecoder().decode(f.payload)));
    }
  }

  private waitForText(path: string): Promise<void> {
    return waitForKey(() => this.map, path, () => this.s.ysync.resync(), "file did not arrive");
  }

  // ------------------------------------------------------------------ host ---

  private setupHost() {
    const rpc = this.s.rpc;
    rpc.handle("fs.list", ({ dir }) => invoke("fs_list", { rel: dir }));
    rpc.handle("fs.open", ({ path }) => this.hostOpen(path));
    rpc.handle("fs.create", ({ path, dir }) => invoke("fs_create", { rel: path, dir }));
    rpc.handle("fs.delete", ({ path }) => this.hostRemove(path));
    rpc.handle("fs.rename", ({ from, to }) => this.hostRename(from, to));
    rpc.handle("clone.list", () => invoke("fs_clone_list"));
    rpc.handle("fs.fetch", ({ path, stream }) => this.serveFile(path, stream));
    rpc.handle("fs.cancel", ({ stream }) => {
      this.cancelled.add(stream);
      this.s.bulk.drop(stream);
    });
    rpc.handle("fs.copy", ({ from, to }) => invoke("fs_copy", { from, to }));
    rpc.handle("fs.trash", ({ paths }) => this.hostTrash(paths));
    rpc.handle("fs.unique", ({ rel }) => invoke("fs_unique", { rel }));
    // Guest upload: open registers where a stream's bytes go, wait resolves when written.
    rpc.handle("fs.uploadOpen", async ({ path, stream }) => {
      await invoke("fs_write_bytes", new Uint8Array(0), { headers: { "x-rel": headerSafe(path), "x-offset": "0" } });
      const done = new Promise<void>((resolve, reject) => {
        this.sinks.set(stream, {
          onData: (c, offset) =>
            offset === 0 && c.length === 0
              ? undefined
              : invoke("fs_write_bytes", c, { headers: { "x-rel": headerSafe(path), "x-offset": String(offset) } }),
          resolve,
          reject,
          received: 0,
          queue: Promise.resolve(),
        });
      });
      done.catch(() => {});
      this.uploads.set(stream, done);
    });
    rpc.handle("fs.uploadWait", async ({ stream }) => {
      const p = this.uploads.get(stream);
      this.uploads.delete(stream);
      await p;
    });

    void listen<{ path: string; exists: boolean; dir: boolean }[]>("fs-changed", (e) => this.onDiskChange(e.payload));
    this.observeDoc();
  }

  /** Called again when the session swaps documents. */
  observeDoc() {
    if (this.s.role !== "host") return;
    this.map.observeDeep((events, tr) => {
      if (tr.origin === "disk" || tr.origin === "load") return;
      for (const ev of events) {
        if (ev.target instanceof Y.Text) {
          const path = this.pathOf(ev.target);
          if (path) this.scheduleSave(path);
        }
      }
    });
  }

  private pathOf(t: Y.Text): string | null {
    for (const [k, v] of this.map) if (v === t) return k;
    return null;
  }

  private hostOpen(path: string): Promise<OpenResult> {
    if (/\.ipynb$/i.test(path)) {
      return this.s.notebooks.open(path).then(
        () => ({ kind: "notebook" }) as OpenResult,
        // Not valid nbformat: fall back to editing the JSON as text.
        () => this.loadIntoDoc(path),
      );
    }
    if (this.map.has(path)) return Promise.resolve({ kind: "text" });
    let p = this.opening.get(path);
    if (!p) {
      p = this.loadIntoDoc(path).finally(() => this.opening.delete(path));
      this.opening.set(path, p);
    }
    return p;
  }

  private async loadIntoDoc(path: string): Promise<OpenResult> {
    const st = await invoke<Stat>("fs_stat", { rel: path });
    if (st.size > MAX_LIVE_TEXT) return { kind: "large", size: st.size, hash: st.hash };
    const bytes = new Uint8Array(await invoke<ArrayBuffer>("fs_read", { rel: path }));
    const text = decodeText(bytes);
    if (text === null) return { kind: "binary", size: st.size, hash: st.hash };
    this.format.set(path, { crlf: text.includes("\r\n"), bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf });
    const normalized = text.replace(/\r\n/g, "\n");
    this.lastSaved.set(path, normalized);
    if (!this.map.has(path)) {
      this.s.doc.transact(() => {
        const t = new Y.Text();
        t.insert(0, normalized);
        this.map.set(path, t);
      }, "load");
    }
    return { kind: "text" };
  }

  private scheduleSave(path: string) {
    clearTimeout(this.saveTimers.get(path));
    this.saveTimers.set(
      path,
      window.setTimeout(() => void this.save(path), SAVE_DELAY_MS),
    );
  }

  private async save(path: string) {
    this.saveTimers.delete(path);
    const t = this.map.get(path);
    if (!t) return;
    const text = t.toString();
    if (this.lastSaved.get(path) === text) return;
    this.lastSaved.set(path, text);
    const fmt = this.format.get(path) ?? { crlf: false, bom: false };
    let out = fmt.crlf ? text.replace(/\n/g, "\r\n") : text;
    if (fmt.bom) out = "﻿" + out;
    try {
      await invoke("fs_write_text", { rel: path, text: out });
    } catch (e) {
      this.lastSaved.delete(path);
      this.s.toast(`Could not save ${path}: ${e}`);
    }
  }

  /** Flush pending saves (before running code, or on exit). */
  async flush() {
    const paths = [...this.saveTimers.keys()];
    paths.forEach((p) => clearTimeout(this.saveTimers.get(p)));
    await Promise.all(paths.map((p) => this.save(p)));
  }

  private async onDiskChange(changes: { path: string; exists: boolean; dir: boolean }[]) {
    const dirs = new Set<string>();
    for (const c of changes) {
      dirs.add(dirname(c.path));
      const t = this.map.get(c.path);
      if (!t) continue;
      if (!c.exists) {
        // Give a rename a moment to show up as its own event first.
        setTimeout(() => {
          if (this.map.get(c.path) === t) this.s.doc.transact(() => this.map.delete(c.path), "disk");
        }, 300);
        continue;
      }
      try {
        const bytes = new Uint8Array(await invoke<ArrayBuffer>("fs_read", { rel: c.path }));
        const text = decodeText(bytes);
        if (text === null) continue;
        const normalized = text.replace(/\r\n/g, "\n");
        if (normalized === this.lastSaved.get(c.path)) continue; // our own write
        if (this.saveTimers.has(c.path)) continue; // unsaved edits win; they'll overwrite shortly
        this.lastSaved.set(c.path, normalized);
        this.s.doc.transact(() => applyText(t, normalized), "disk");
      } catch {
        /* file vanished between event and read */
      }
    }
    const list = [...dirs];
    this.emit("changed", list);
    this.s.rpc.notify("fs.changed", list);
  }

  private async hostTrash(paths: string[]) {
    await this.flush();
    await invoke("fs_trash", { rels: paths });
    for (const k of [...this.s.notebooks.map.keys()]) if (paths.some((p) => k === p || k.startsWith(p + "/"))) this.s.notebooks.forget(k);
    this.s.doc.transact(() => {
      for (const k of [...this.map.keys()]) if (paths.some((p) => k === p || k.startsWith(p + "/"))) this.map.delete(k);
    }, "disk");
  }

  private async hostRemove(path: string) {
    await invoke("fs_delete", { rel: path });
    this.s.doc.transact(() => {
      for (const k of [...this.map.keys()]) if (k === path || k.startsWith(path + "/")) this.map.delete(k);
    }, "disk");
  }

  private async hostRename(from: string, to: string) {
    await this.flush();
    await invoke("fs_rename", { from, to });
    // Carry open documents over to their new paths so editors stay open.
    this.s.doc.transact(() => {
      for (const k of [...this.map.keys()]) {
        if (k !== from && !k.startsWith(from + "/")) continue;
        const nk = to + k.slice(from.length);
        const old = this.map.get(k)!;
        const t = new Y.Text();
        t.insert(0, old.toString());
        this.map.delete(k);
        this.map.set(nk, t);
        this.lastSaved.set(nk, this.lastSaved.get(k) ?? old.toString());
        const fmt = this.format.get(k);
        if (fmt) this.format.set(nk, fmt);
      }
    }, "load");
    this.emit("renamed", { from, to });
    this.s.rpc.notify("fs.renamed", { from, to });
  }

  private async serveFile(path: string, stream: number): Promise<{ size: number; hash: string }> {
    const st = await invoke<Stat>("fs_stat", { rel: path });
    void (async () => {
      const bulk = this.s.bulk;
      try {
        for (let off = 0; off < st.size; ) {
          if (this.cancelled.has(stream)) return;
          await bulk.waitQueued(stream, 2 * READ_CHUNK);
          const chunk = new Uint8Array(await invoke<ArrayBuffer>("fs_read_range", { rel: path, offset: off, len: READ_CHUNK }));
          if (!chunk.length) break;
          bulk.send(Kind.FileData, stream, chunk);
          off += chunk.length;
        }
        bulk.send(Kind.FileEnd, stream);
      } catch (e) {
        bulk.send(Kind.FileErr, stream, new TextEncoder().encode(String(e)));
      } finally {
        this.cancelled.delete(stream);
      }
    })();
    return { size: st.size, hash: st.hash };
  }
}

/**
 * Guest: wait until the host's document puts `key` into the map. If it is
 * slow, ask for a resync (repairs a lost update) and keep waiting.
 * `map` is a getter: the session may swap documents meanwhile.
 */
export function waitForKey(map: () => { has(key: string): boolean }, key: string, resync: () => void, error: string): Promise<void> {
  if (map().has(key)) return Promise.resolve();
  return new Promise((res, rej) => {
    const started = Date.now();
    let nudged = 0;
    const iv = window.setInterval(() => {
      if (map().has(key)) {
        clearInterval(iv);
        return res();
      }
      const waited = Date.now() - started;
      if (waited > 30_000) {
        clearInterval(iv);
        rej(new Error(error));
      } else if (waited > 1500 + nudged * 5000) {
        nudged++;
        resync();
      }
    }, 100);
  });
}

/** A transfer's state can change from the UI while a loop runs. */
const isCancelled = (t: Transfer) => t.state === "cancelled";

/** UTF-8 text, or null if the bytes look binary. */
export function decodeText(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, 8000);
  if (head.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Replace a Y.Text's content with `next` as one minimal edit (keeps cursors stable). */
export function applyText(t: Y.Text, next: string) {
  const cur = t.toString();
  if (cur === next) return;
  let start = 0;
  while (start < cur.length && start < next.length && cur[start] === next[start]) start++;
  let end = 0;
  while (
    end < cur.length - start &&
    end < next.length - start &&
    cur[cur.length - 1 - end] === next[next.length - 1 - end]
  )
    end++;
  if (cur.length - start - end > 0) t.delete(start, cur.length - start - end);
  const ins = next.slice(start, next.length - end);
  if (ins) t.insert(start, ins);
}
