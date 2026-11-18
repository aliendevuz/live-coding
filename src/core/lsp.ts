// IntelliSense: language servers run on the host, for both people.
//
// Host: Pyright (Python) and typescript-language-server (JS/TS) are npm
// packages installed once into the app's data folder and started with the
// system `node`. Documents are fed to them from the shared Yjs document, so
// there is one server per language and one truth for both users. Requests
// come from the host's own editor or, through the control channel, from the
// guest's. Diagnostics are broadcast to the guest.
//
// Paths: editors use model URIs like file:///src/app.py (project-relative).
// Servers see real paths (file:///c%3A/.../project/src/app.py). Conversion
// happens here, in both directions.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as Y from "yjs";
import { monaco } from "../ui/monaco-setup";
import type { Session } from "./session";
import { Emitter, sleep } from "./util";

export type ServerKey = "python" | "ts";
export type ServerState = "off" | "installing" | "starting" | "ready" | "unavailable";
export type LspStatus = Record<ServerKey, { state: ServerState; error?: string }>;

export interface Diagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
  tags?: number[];
}

interface ServerDef {
  packages: string[];
  entry: string;
  args: string[];
}

const SERVERS: Record<ServerKey, ServerDef> = {
  python: { packages: ["pyright"], entry: "node_modules/pyright/langserver.index.js", args: ["--stdio"] },
  ts: {
    // typescript 7 is the native port without tsserver.js; the LSP wrapper needs 6.
    packages: ["typescript-language-server", "typescript@6"],
    entry: "node_modules/typescript-language-server/lib/cli.mjs",
    args: ["--stdio"],
  },
};

const LANG: Record<string, { server: ServerKey; id: string }> = {
  py: { server: "python", id: "python" },
  pyi: { server: "python", id: "python" },
  js: { server: "ts", id: "javascript" },
  mjs: { server: "ts", id: "javascript" },
  cjs: { server: "ts", id: "javascript" },
  jsx: { server: "ts", id: "javascriptreact" },
  ts: { server: "ts", id: "typescript" },
  mts: { server: "ts", id: "typescript" },
  cts: { server: "ts", id: "typescript" },
  tsx: { server: "ts", id: "typescriptreact" },
};

export function languageOf(path: string) {
  return LANG[path.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

const REQUEST_TIMEOUT_MS = 15_000;
const SYNC_DELAY_MS = 120;

type Events = {
  status: LspStatus;
  diagnostics: { path: string; diagnostics: Diagnostic[] };
};

interface Doc {
  server: ServerKey;
  uri: string;
  version: number;
  timer: number;
  dirty: boolean;
}

interface Running {
  pending: Map<number, { res: (v: unknown) => void; rej: (e: Error) => void; timer: number }>;
  nextId: number;
  ready: Promise<void>;
}

/** The session's LSP service, for the editor's providers (one session at a time). */
export let activeLsp: Lsp | null = null;

export class Lsp extends Emitter<Events> {
  status: LspStatus = { python: { state: "off" }, ts: { state: "off" } };
  diagnostics = new Map<string, Diagnostic[]>();
  // host only
  private running = new Map<ServerKey, Running>();
  private docs = new Map<string, Doc>();
  private rootUri = "";
  private rootFs = "";
  private env: Promise<{ dir: string; node: string | null }> | null = null;
  private installing: Promise<void> | null = null;
  private disposed = false;
  private offs: (() => void)[] = [];

  constructor(private s: Session) {
    super();
    activeLsp = this;
    if (s.role === "guest") this.setupGuest();
  }

  /** Host: call once the project folder is known. */
  init() {
    if (this.s.role === "host" && !this.rootUri) this.setupHost();
  }

  isReady(server: ServerKey) {
    return this.status[server].state === "ready";
  }

  /**
   * Send a request about a project file. `params.textDocument.uri` is filled
   * in here. `len` is the editor's text length: the host waits until its copy
   * of the document has caught up, so positions line up.
   */
  async request<T = unknown>(path: string, len: number, method: string, params: Record<string, unknown>): Promise<T | null> {
    if (this.s.role === "guest") {
      if (this.s.state !== "connected") return null;
      return this.s.rpc.call<T | null>("lsp.req", { path, len, method, params }, REQUEST_TIMEOUT_MS);
    }
    return this.hostRequest<T>(path, len, method, params);
  }

  dispose() {
    this.disposed = true;
    if (activeLsp === this) activeLsp = null;
    this.offs.forEach((f) => f());
    for (const key of this.running.keys()) void invoke("lsp_stop", { id: key });
    this.running.clear();
    for (const path of [...this.diagnostics.keys()]) this.emit("diagnostics", { path, diagnostics: [] });
    this.diagnostics.clear();
  }

  private setStatus(server: ServerKey, state: ServerState, error?: string) {
    this.status = { ...this.status, [server]: { state, error } };
    this.emit("status", this.status);
    if (this.s.role === "host") this.s.rpc.notify("lsp.status", this.status);
  }

  private setDiagnostics(path: string, diagnostics: Diagnostic[]) {
    if (diagnostics.length) this.diagnostics.set(path, diagnostics);
    else this.diagnostics.delete(path);
    this.emit("diagnostics", { path, diagnostics });
  }

  // ----------------------------------------------------------------- guest ---

  private setupGuest() {
    this.offs.push(
      this.s.rpc.on("lsp.status", (st: LspStatus) => {
        this.status = st;
        this.emit("status", st);
      }),
      this.s.rpc.on("lsp.diag", ({ path, diagnostics }) => this.setDiagnostics(path, diagnostics)),
      this.s.rpc.on("lsp.diagAll", (all: [string, Diagnostic[]][]) => {
        for (const path of [...this.diagnostics.keys()]) this.setDiagnostics(path, []);
        for (const [path, d] of all) this.setDiagnostics(path, d);
      }),
    );
  }

  // ------------------------------------------------------------------ host ---

  private setupHost() {
    const root = this.s.projectPath.replace(/\\/g, "/");
    this.rootFs = root.toLowerCase();
    this.rootUri = monaco.Uri.file(root).toString();

    this.s.rpc.handle("lsp.req", ({ path, len, method, params }) => this.hostRequest(path, len, method, params));
    this.offs.push(
      this.s.link.on("open", () => {
        this.s.rpc.notify("lsp.status", this.status);
        this.s.rpc.notify("lsp.diagAll", [...this.diagnostics]);
      }),
    );
    // Servers cache the folder layout for import resolution: tell them about
    // files created, changed or deleted on disk (by Duet, the terminal, git...),
    // as VS Code does. Without this a module made after start never resolves.
    void listen<{ path: string; exists: boolean; dir: boolean; created: boolean }[]>("fs-changed", (e) => {
      const changes = e.payload.map((c) => ({ uri: this.uriOf(c.path), type: !c.exists ? 3 : c.created ? 1 : 2 }));
      for (const [server] of this.running) {
        if (this.isReady(server)) this.notifyServer(server, "workspace/didChangeWatchedFiles", { changes });
      }
    }).then((un) => (this.disposed ? un() : this.offs.push(un)));
    void listen<{ id: ServerKey }>("lsp-exit", (e) => {
      if (this.disposed || !this.running.has(e.payload.id)) return;
      this.running.delete(e.payload.id);
      for (const [, d] of this.docs) if (d.server === e.payload.id) clearTimeout(d.timer);
      for (const [p, d] of [...this.docs]) if (d.server === e.payload.id) this.docs.delete(p);
      this.setStatus(e.payload.id, "unavailable", "The language server stopped.");
    }).then((un) => (this.disposed ? un() : this.offs.push(un)));

    // Feed every live text file to its server.
    const map = this.s.files.map;
    const onMap = (ev: Y.YMapEvent<Y.Text>) => {
      ev.keysChanged.forEach((path) => (map.has(path) ? this.openDoc(path) : this.closeDoc(path)));
    };
    const onDeep = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      for (const ev of events) {
        if (!(ev.target instanceof Y.Text)) continue;
        for (const [path, t] of map) if (t === ev.target) this.markDirty(path);
      }
    };
    map.observe(onMap);
    map.observeDeep(onDeep);
    this.offs.push(() => map.unobserve(onMap), () => map.unobserveDeep(onDeep));
    for (const path of map.keys()) this.openDoc(path);
  }

  private uriOf(path: string) {
    return monaco.Uri.file(`${this.s.projectPath.replace(/\\/g, "/")}/${path}`).toString();
  }

  /** Server URI -> project-relative path, or null if outside the project. */
  private relOf(uri: string): string | null {
    let p: string;
    try {
      p = monaco.Uri.parse(uri).fsPath.replace(/\\/g, "/");
    } catch {
      return null;
    }
    const lower = p.toLowerCase();
    if (!lower.startsWith(this.rootFs + "/")) return null;
    return p.slice(this.rootFs.length + 1);
  }

  /** Rewrite server URIs in a response to the editors' model URIs. */
  private mapBack(v: unknown): unknown {
    if (Array.isArray(v)) return v.map((x) => this.mapBack(x));
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if ((k === "uri" || k === "targetUri") && typeof x === "string") {
        const rel = this.relOf(x);
        out[k] = rel != null ? monaco.Uri.file("/" + rel).toString() : x;
      } else if (k === "changes" && x && typeof x === "object" && !Array.isArray(x)) {
        // WorkspaceEdit.changes is keyed by URI.
        const ch: Record<string, unknown> = {};
        for (const [u, edits] of Object.entries(x as Record<string, unknown>)) {
          const rel = this.relOf(u);
          ch[rel != null ? monaco.Uri.file("/" + rel).toString() : u] = edits;
        }
        out[k] = ch;
      } else out[k] = this.mapBack(x);
    }
    return out;
  }

  private getEnv() {
    this.env ??= invoke<{ dir: string; node: string | null }>("lsp_env");
    return this.env;
  }

  /** Install (once) and start a server; resolves when it is initialized. */
  private ensure(server: ServerKey): Promise<void> {
    const r = this.running.get(server);
    if (r) return r.ready;
    if (this.status[server].state === "unavailable") return Promise.reject(new Error(this.status[server].error));
    const run: Running = { pending: new Map(), nextId: 1, ready: Promise.resolve() };
    this.running.set(server, run);
    run.ready = this.start(server, run).catch((e) => {
      this.running.delete(server);
      this.setStatus(server, "unavailable", e instanceof Error ? e.message : String(e));
      throw e;
    });
    run.ready.catch(() => {});
    return run.ready;
  }

  private async start(server: ServerKey, run: Running) {
    const env = await this.getEnv();
    if (!env.node) throw new Error("Node.js was not found on this computer. Install it from nodejs.org to get IntelliSense.");
    const def = SERVERS[server];
    if (!(await invoke<boolean>("lsp_has", { rel: def.entry }))) {
      this.setStatus(server, "installing");
      await this.installAll();
    }
    this.setStatus(server, "starting");
    const onMsg = new Channel<ArrayBuffer>();
    const decoder = new TextDecoder();
    onMsg.onmessage = (buf) => {
      try {
        this.onServerMessage(server, run, JSON.parse(decoder.decode(buf)));
      } catch (e) {
        console.warn("lsp: bad message", e);
      }
    };
    await invoke("lsp_start", { id: server, node: env.node, entry: def.entry, args: def.args, cwd: this.s.projectPath, onMsg });
    const name = this.s.projectName || "project";
    await this.send(server, run, "initialize", {
      processId: null,
      clientInfo: { name: "Duet" },
      rootUri: this.rootUri,
      workspaceFolders: [{ uri: this.rootUri, name }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions:
        server === "ts"
          ? {
              tsserver: { path: `${env.dir}/node_modules/typescript/lib/tsserver.js` },
              preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true },
            }
          : undefined,
    });
    this.notifyServer(server, "initialized", {});
    this.setStatus(server, "ready");
    // Documents that were opened while the server was starting.
    for (const path of this.s.files.map.keys()) if (languageOf(path)?.server === server) this.openDoc(path);
  }

  /** One npm call for every server that is missing (they install together). */
  private installAll(): Promise<void> {
    this.installing ??= (async () => {
      const missing: string[] = [];
      for (const def of Object.values(SERVERS)) {
        if (!(await invoke<boolean>("lsp_has", { rel: def.entry }))) missing.push(...def.packages);
      }
      if (!missing.length) return;
      this.s.toast("Setting up IntelliSense (one time, about 60 MB)…");
      await invoke("lsp_install", { packages: missing });
      this.s.toast("IntelliSense is ready.");
    })().finally(() => (this.installing = null));
    return this.installing;
  }

  private send(server: ServerKey, run: Running, method: string, params: unknown): Promise<unknown> {
    const id = run.nextId++;
    return new Promise((res, rej) => {
      const timer = window.setTimeout(() => {
        run.pending.delete(id);
        rej(new Error(`${method} timed out`));
      }, method === "initialize" ? 120_000 : REQUEST_TIMEOUT_MS);
      run.pending.set(id, { res, rej, timer });
      invoke("lsp_send", { id: server, msg: JSON.stringify({ jsonrpc: "2.0", id, method, params }) }).catch((e) => {
        clearTimeout(timer);
        run.pending.delete(id);
        rej(new Error(String(e)));
      });
    });
  }

  private notifyServer(server: ServerKey, method: string, params: unknown) {
    void invoke("lsp_send", { id: server, msg: JSON.stringify({ jsonrpc: "2.0", method, params }) }).catch(() => {});
  }

  private reply(server: ServerKey, id: number | string, result: unknown) {
    void invoke("lsp_send", { id: server, msg: JSON.stringify({ jsonrpc: "2.0", id, result }) }).catch(() => {});
  }

  private onServerMessage(server: ServerKey, run: Running, msg: { id?: number | string; method?: string; params?: any; result?: unknown; error?: { message: string } }) {
    if (msg.method === undefined && msg.id !== undefined) {
      const p = run.pending.get(msg.id as number);
      if (!p) return;
      run.pending.delete(msg.id as number);
      clearTimeout(p.timer);
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
      return;
    }
    if (msg.id !== undefined) {
      // Requests from the server.
      switch (msg.method) {
        case "workspace/configuration":
          return void this.configuration(msg.params?.items ?? []).then((r) => this.reply(server, msg.id!, r));
        case "workspace/workspaceFolders":
          return this.reply(server, msg.id, [{ uri: this.rootUri, name: this.s.projectName }]);
        default:
          // client/registerCapability, window/workDoneProgress/create, ...: acknowledge.
          return this.reply(server, msg.id, null);
      }
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const path = this.relOf(msg.params.uri);
      if (path == null) return;
      const diagnostics = msg.params.diagnostics as Diagnostic[];
      this.setDiagnostics(path, diagnostics);
      this.s.rpc.notify("lsp.diag", { path, diagnostics });
    }
  }

  private pythonPath: Promise<string> | null = null;

  /** Use the project's virtualenv when there is one. */
  private findPython(): Promise<string> {
    this.pythonPath ??= (async () => {
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
    return this.pythonPath;
  }

  private async configuration(items: { section?: string }[]) {
    const python = await this.findPython();
    return items.map((it) => {
      switch (it.section) {
        case "python":
          return { pythonPath: python };
        case "python.analysis":
          return { autoSearchPaths: true, useLibraryCodeForTypes: true, diagnosticMode: "openFilesOnly", typeCheckingMode: "basic" };
        default:
          return null;
      }
    });
  }

  // ---- documents ----

  private openDoc(path: string) {
    const lang = languageOf(path);
    if (!lang || this.docs.has(path) || this.disposed) return;
    const st = this.status[lang.server].state;
    if (st === "unavailable") return;
    if (st !== "ready") {
      void this.ensure(lang.server).catch(() => {});
      return; // start() opens it once the server is ready
    }
    const text = this.s.files.map.get(path)?.toString();
    if (text === undefined) return;
    const doc: Doc = { server: lang.server, uri: this.uriOf(path), version: 1, timer: 0, dirty: false };
    this.docs.set(path, doc);
    this.notifyServer(lang.server, "textDocument/didOpen", {
      textDocument: { uri: doc.uri, languageId: lang.id, version: doc.version, text },
    });
  }

  private closeDoc(path: string) {
    const doc = this.docs.get(path);
    if (!doc) return;
    clearTimeout(doc.timer);
    this.docs.delete(path);
    this.notifyServer(doc.server, "textDocument/didClose", { textDocument: { uri: doc.uri } });
    this.setDiagnostics(path, []);
    this.s.rpc.notify("lsp.diag", { path, diagnostics: [] });
  }

  private markDirty(path: string) {
    const doc = this.docs.get(path);
    if (!doc) return;
    doc.dirty = true;
    clearTimeout(doc.timer);
    doc.timer = window.setTimeout(() => this.flush(path), SYNC_DELAY_MS);
  }

  private flush(path: string) {
    const doc = this.docs.get(path);
    if (!doc || !doc.dirty) return;
    clearTimeout(doc.timer);
    doc.dirty = false;
    doc.version++;
    const text = this.s.files.map.get(path)?.toString() ?? "";
    this.notifyServer(doc.server, "textDocument/didChange", {
      textDocument: { uri: doc.uri, version: doc.version },
      contentChanges: [{ text }],
    });
  }

  private async hostRequest<T>(path: string, len: number, method: string, params: Record<string, unknown>): Promise<T | null> {
    const lang = languageOf(path);
    if (!lang) return null;
    const ytext = this.s.files.map.get(path);
    if (!ytext) return null;
    try {
      await this.ensure(lang.server);
    } catch {
      return null;
    }
    if (!this.docs.has(path)) this.openDoc(path);
    // The guest's keystrokes travel on another channel: let them land first.
    for (let i = 0; i < 20 && ytext.length !== len; i++) await sleep(15);
    this.flush(path);
    const doc = this.docs.get(path);
    const run = this.running.get(lang.server);
    if (!doc || !run) return null;
    const p: Record<string, unknown> = { ...params };
    if (method.startsWith("textDocument/")) p.textDocument = { ...((p.textDocument as object) ?? {}), uri: doc.uri };
    const result = await this.send(lang.server, run, method, p);
    return this.mapBack(result) as T;
  }
}

const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
    completion: {
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        documentationFormat: ["markdown", "plaintext"],
        labelDetailsSupport: true,
        deprecatedSupport: true,
        tagSupport: { valueSet: [1] },
        resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
      },
    },
    hover: { contentFormat: ["markdown", "plaintext"] },
    signatureHelp: {
      contextSupport: true,
      signatureInformation: {
        documentationFormat: ["markdown", "plaintext"],
        parameterInformation: { labelOffsetSupport: true },
        activeParameterSupport: true,
      },
    },
    definition: { linkSupport: true },
    typeDefinition: { linkSupport: true },
    references: {},
    documentHighlight: {},
    rename: { prepareSupport: false },
    publishDiagnostics: { relatedInformation: false, tagSupport: { valueSet: [1, 2] }, versionSupport: false },
  },
  workspace: {
    configuration: true,
    workspaceFolders: true,
    applyEdit: false,
    didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
  },
  general: { positionEncodings: ["utf-16"] },
};
