// Shared terminals. Real shells run on the host (Rust PTY). The host renders
// them in xterm.js and mirrors every byte to the guest over the `term`
// channel. The guest may type only while the host allows it.
//
// term channel frame: [type u8][terminal id u32][payload]
//   type 0 = output bytes, 1 = snapshot (reset the screen, then write payload)

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { Session } from "./session";
import { Emitter, SerialQueue, basename } from "./util";

export interface TermView {
  id: number;
  title: string;
  alive: boolean;
  term: Terminal;
  el: HTMLDivElement;
  fit?: FitAddon;
  serialize?: SerializeAddon;
}

interface TermInfo {
  id: number;
  title: string;
  alive: boolean;
  cols: number;
  rows: number;
}

const T_DATA = 0;
const T_SNAPSHOT = 1;
const TERM_LAG_BYTES = 1024 * 1024;
const STATIC_PORT = 5500;

/** How to run a file, by extension. Paths are relative to the project root. */
const RUNNERS: Record<string, (f: string) => string> = {
  py: (f) => `python "${f}"`,
  js: (f) => `node "${f}"`,
  mjs: (f) => `node "${f}"`,
  cjs: (f) => `node "${f}"`,
  ts: (f) => `npx --yes tsx "${f}"`,
  ps1: (f) => `& ".\\${f.replace(/\//g, "\\")}"`,
  bat: (f) => `& ".\\${f.replace(/\//g, "\\")}"`,
  cmd: (f) => `& ".\\${f.replace(/\//g, "\\")}"`,
  go: (f) => `go run "${f}"`,
  rb: (f) => `ruby "${f}"`,
  php: (f) => `php "${f}"`,
  java: (f) => `java "${f}"`,
  c: (f) => `gcc "${f}" -o "$env:TEMP\\duet_run.exe"; if ($?) { & "$env:TEMP\\duet_run.exe" }`,
  cpp: (f) => `g++ "${f}" -o "$env:TEMP\\duet_run.exe"; if ($?) { & "$env:TEMP\\duet_run.exe" }`,
};

export function canRun(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ext in RUNNERS || ext === "html" || ext === "htm";
}

// xterm answers terminal queries (cursor position, device attributes, focus)
// through onData. Only the host's xterm should answer; the guest's copy would
// type duplicate replies into the shell.
const AUTO_REPLY = /^(\x1b\[\??[\d;]*[cRn]|\x1b\[[IO]|\x1b\][\d;]*[^\x07]*\x07)+$/;

type Events = {
  list: TermView[];
  /** Show this terminal: `remote` when the partner pressed Run. */
  reveal: { id: number; remote: boolean };
};

export class Terminals extends Emitter<Events> {
  views = new Map<number, TermView>();
  private lagging = new Set<number>();
  /** Guest: frames for terminals whose term.list entry has not arrived yet. */
  private early = new Map<number, ArrayBuffer[]>();
  private writeQueues = new Map<number, SerialQueue>();

  constructor(private s: Session) {
    super();
    if (s.role === "host") this.setupHost();
    else this.setupGuest();
  }

  list() {
    return [...this.views.values()];
  }

  private makeView(id: number, title: string, cols: number, rows: number): TermView {
    const term = new Terminal({
      cols,
      rows,
      fontFamily: "Cascadia Mono, Consolas, SF Mono, Menlo, monospace",
      fontSize: 13,
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: "#1a1a1d",
        foreground: "#d8d8dc",
        cursor: "#0d99ff",
        cursorAccent: "#1a1a1d",
        selectionBackground: "#0d99ff44",
        black: "#2a2a2f", red: "#ff6b5a", green: "#3ccf7e", yellow: "#ffc152", blue: "#3aaaff",
        magenta: "#a18cff", cyan: "#4fd6e6", white: "#d8d8dc",
        brightBlack: "#67676f", brightRed: "#ff8a70", brightGreen: "#5ee39a", brightYellow: "#ffd27a",
        brightBlue: "#6cc0ff", brightMagenta: "#bfb0ff", brightCyan: "#7fe6f2", brightWhite: "#ffffff",
      },
      lineHeight: 1.2,
    });
    const el = document.createElement("div");
    el.className = "xterm-host";
    const v: TermView = { id, title, alive: true, term, el };
    this.views.set(id, v);
    return v;
  }

  private changed() {
    this.emit("list", this.list());
    if (this.s.role === "host") this.s.rpc.notify("term.list", this.infos());
  }

  private infos(): TermInfo[] {
    return this.list().map((v) => ({ id: v.id, title: v.title, alive: v.alive, cols: v.term.cols, rows: v.term.rows }));
  }

  /** Mount a terminal into a panel element (called by the UI on tab switch). */
  attach(v: TermView, parent: HTMLElement) {
    if (v.el.parentElement !== parent) parent.appendChild(v.el);
    if (!v.term.element) v.term.open(v.el);
    this.fit(v);
    v.term.focus();
  }

  /** Host: size the PTY to the panel. Guest keeps the host's size. */
  fit(v: TermView) {
    if (!v.fit || !v.el.isConnected) return;
    const before = `${v.term.cols}x${v.term.rows}`;
    try {
      v.fit.fit();
    } catch {
      return;
    }
    if (`${v.term.cols}x${v.term.rows}` !== before && v.alive) {
      void invoke("pty_resize", { id: v.id, cols: v.term.cols, rows: v.term.rows });
      this.s.rpc.notify("term.resize", { id: v.id, cols: v.term.cols, rows: v.term.rows });
    }
  }

  /** Open a new shell (host), or ask the host for one (guest with permission). */
  async create(title?: string): Promise<number> {
    if (this.s.role === "guest") return this.s.rpc.call("term.create", { title });
    return this.spawn(title);
  }

  async kill(id: number) {
    if (this.s.role === "guest") return this.s.rpc.call("term.kill", { id });
    const v = this.views.get(id);
    if (!v) return;
    if (v.alive) await invoke("pty_kill", { id });
    this.remove(id);
  }

  /** Run a file: in a fresh terminal, or as a static site for HTML. */
  /**
   * Run a file. The same "Run: file" terminal is reused, so earlier output
   * stays above for comparison; whoever pressed Run gets the panel shown.
   */
  async run(path: string): Promise<void> {
    if (this.s.role === "guest") {
      const id = await this.s.rpc.call<number>("term.run", { path });
      if (id >= 0) this.revealWhenListed(id, false);
      return;
    }
    const id = await this.hostRun(path);
    if (id < 0) return;
    this.emit("reveal", { id, remote: false });
    this.s.rpc.notify("term.reveal", { id });
  }

  private async hostRun(path: string): Promise<number> {
    await this.s.files.flush();
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "html" || ext === "htm") return this.runHtml(path);
    const cmd = RUNNERS[ext];
    if (!cmd) throw new Error(`Don't know how to run .${ext} files`);
    const title = `Run: ${basename(path)}`;
    const existing = [...this.views.values()].find((v) => v.title === title && v.alive);
    if (existing) {
      // Stop a program that may still be running, then run again below it.
      this.input(existing.id, "\x03");
      setTimeout(() => this.input(existing.id, cmd(path) + "\r"), 150);
      return existing.id;
    }
    const id = await this.spawn(title);
    // Give the shell a moment to print its prompt before typing.
    setTimeout(() => this.input(id, cmd(path) + "\r"), 400);
    return id;
  }

  /** Guest: the terminal may not be in our list yet when its id arrives. */
  private revealWhenListed(id: number, remote: boolean) {
    if (this.views.has(id)) return this.emit("reveal", { id, remote });
    const off = this.on("list", () => {
      if (!this.views.has(id)) return;
      off();
      this.emit("reveal", { id, remote });
    });
    setTimeout(off, 5000);
  }

  /**
   * HTML: the built-in live server (Rust) serves the project and patches the
   * open page when files change, on both screens (the guest gets the port).
   * No terminal is involved, so this returns -1.
   */
  private async runHtml(path: string): Promise<number> {
    const port = await invoke<number>("live_start", { port: STATIC_PORT });
    this.s.tunnels.share(port);
    const url = `http://localhost:${port}/${path.split("/").map(encodeURIComponent).join("/")}`;
    void openUrl(url);
    this.s.rpc.notify("preview", { port, path });
    return -1;
  }

  input(id: number, data: string) {
    if (this.s.role === "guest") {
      if (this.s.perms.terminal) this.s.rpc.notify("term.input", { id, data });
      return;
    }
    let q = this.writeQueues.get(id);
    if (!q) this.writeQueues.set(id, (q = new SerialQueue()));
    void q.run(() => invoke("pty_write", { id, data }).catch(() => {}));
  }

  // ------------------------------------------------------------------ host ---

  private setupHost() {
    const rpc = this.s.rpc;
    const allowed = () => {
      if (!this.s.perms.terminal) throw new Error("The host has not given you terminal access.");
    };
    // The student's keys go to a guarded shell only (pty.rs + duet_guard.ps1):
    // commands they run must stay inside the project folder.
    let warned = false;
    rpc.on("term.input", ({ id, data }) => {
      if (!this.s.perms.terminal) return;
      let q = this.writeQueues.get(id);
      if (!q) this.writeQueues.set(id, (q = new SerialQueue()));
      void q.run(() =>
        invoke("pty_write_guest", { id, data }).catch((e) => {
          if (warned) return;
          warned = true;
          this.s.toast(String(e));
        }),
      );
    });
    rpc.handle("term.create", ({ title }) => (allowed(), this.spawn(title)));
    rpc.handle("term.kill", ({ id }) => (allowed(), this.kill(id)));
    rpc.handle("term.run", async ({ path }) => {
      allowed();
      // Only files inside the project, and nothing that could break out of the quoted command.
      if (typeof path !== "string" || !path || /(^|[\\/])\.\.([\\/]|$)|^[\\/]|^[a-z]:|["'`$;&|\r\n]/i.test(path)) {
        throw new Error("Only files inside the project can be run.");
      }
      const id = await this.hostRun(path);
      if (id >= 0) this.emit("reveal", { id, remote: true });
      return id;
    });

    void listen<{ id: number; code: number | null }>("pty-exit", (e) => {
      const v = this.views.get(e.payload.id);
      if (!v) return;
      v.alive = false;
      const msg = `\r\n\x1b[90m[process exited${e.payload.code != null ? ` with code ${e.payload.code}` : ""}]\x1b[0m\r\n`;
      v.term.write(msg);
      this.mirror(v.id, new TextEncoder().encode(msg));
      this.changed();
    });

    this.s.link.on("open", () => {
      // Fresh connection: the guest gets the list, then each screen as a snapshot.
      this.lagging.clear();
      this.s.rpc.notify("term.list", this.infos());
      for (const v of this.views.values()) this.snapshot(v);
      const dc = this.s.link.channel("term");
      dc?.addEventListener("bufferedamountlow", () => {
        for (const id of [...this.lagging]) {
          this.lagging.delete(id);
          const v = this.views.get(id);
          if (v) this.snapshot(v);
        }
      });
    });
  }

  private async spawn(title?: string): Promise<number> {
    const onData = new Channel<ArrayBuffer>();
    const pending: Uint8Array[] = [];
    let view: TermView | null = null;
    onData.onmessage = (buf) => {
      const bytes = new Uint8Array(buf);
      if (!view) return void pending.push(bytes);
      view.term.write(bytes);
      this.mirror(view.id, bytes);
    };
    const cols = 100;
    const rows = 28;
    const id = await invoke<number>("pty_spawn", { cwd: this.s.projectPath, cols, rows, onData });
    const n = [...this.views.values()].filter((v) => !v.title.startsWith("Run:") && !v.title.startsWith("Static server")).length + 1;
    const v = this.makeView(id, title || `Terminal ${n}`, cols, rows);
    v.fit = new FitAddon();
    v.serialize = new SerializeAddon();
    v.term.loadAddon(v.fit);
    v.term.loadAddon(v.serialize);
    v.term.onData((d) => this.input(id, d));
    view = v;
    pending.forEach((b) => {
      v.term.write(b);
      this.mirror(id, b);
    });
    this.changed();
    return id;
  }

  private remove(id: number) {
    const v = this.views.get(id);
    if (!v) return;
    v.term.dispose();
    v.el.remove();
    this.views.delete(id);
    this.writeQueues.delete(id);
    this.changed();
  }

  private frame(type: number, id: number, payload: Uint8Array) {
    const f = new Uint8Array(5 + payload.length);
    const dv = new DataView(f.buffer);
    dv.setUint8(0, type);
    dv.setUint32(1, id, true);
    f.set(payload, 5);
    return f;
  }

  private mirror(id: number, bytes: Uint8Array) {
    const dc = this.s.link.channel("term");
    if (!dc || this.lagging.has(id)) return;
    if (dc.bufferedAmount > TERM_LAG_BYTES) {
      // The guest is behind (e.g. a flood of output on a slow link): stop
      // streaming and send one snapshot of the screen once the queue drains.
      this.lagging.add(id);
      return;
    }
    dc.send(this.frame(T_DATA, id, bytes) as Uint8Array<ArrayBuffer>);
  }

  private snapshot(v: TermView) {
    const dc = this.s.link.channel("term");
    if (!dc || !v.serialize) return;
    // Let pending writes land in the buffer before serializing it.
    v.term.write("", () => {
      const data = new TextEncoder().encode(v.serialize!.serialize({ scrollback: 1000 }));
      dc.send(this.frame(T_SNAPSHOT, v.id, data) as Uint8Array<ArrayBuffer>);
    });
  }

  // ----------------------------------------------------------------- guest ---

  private setupGuest() {
    const rpc = this.s.rpc;
    rpc.on("term.list", (infos: TermInfo[]) => {
      const keep = new Set(infos.map((i) => i.id));
      for (const id of [...this.views.keys()]) if (!keep.has(id)) this.remove(id);
      for (const i of infos) {
        let v = this.views.get(i.id);
        if (!v) {
          v = this.makeView(i.id, i.title, i.cols, i.rows);
          const id = i.id;
          v.term.onData((d) => {
            if (!AUTO_REPLY.test(d)) this.input(id, d);
          });
          const early = this.early.get(id);
          this.early.delete(id);
          early?.forEach((b) => this.onTermFrame(b));
        }
        v.title = i.title;
        v.alive = i.alive;
        if (v.term.cols !== i.cols || v.term.rows !== i.rows) v.term.resize(i.cols, i.rows);
      }
      this.emit("list", this.list());
    });
    rpc.on("term.resize", ({ id, cols, rows }) => this.views.get(id)?.term.resize(cols, rows));
    rpc.on("term.reveal", ({ id }) => this.revealWhenListed(id, true));
    this.s.link.on("term", (buf) => this.onTermFrame(buf));
    this.s.link.on("open", () => this.early.clear());
  }

  private onTermFrame(buf: ArrayBuffer) {
    const dv = new DataView(buf);
    const type = dv.getUint8(0);
    const id = dv.getUint32(1, true);
    const v = this.views.get(id);
    if (!v) {
      const q = this.early.get(id) ?? [];
      if (q.length < 256) q.push(buf);
      this.early.set(id, q);
      return;
    }
    const payload = new Uint8Array(buf, 5);
    if (type === T_SNAPSHOT) {
      v.term.reset();
      v.term.write(payload);
    } else v.term.write(payload);
  }
}
