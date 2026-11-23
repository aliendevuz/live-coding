// A lesson session: one link, and every shared feature layered on top of it.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { Bulk } from "../net/bulk";
import { Link, type LinkState, type LinkStats, type Role } from "../net/link";
import { Signaling } from "../net/signaling";
import { Audio, type AudioState, type Levels } from "./audio";
import { Files } from "./files";
import { Lsp } from "./lsp";
import { Notebooks } from "./notebooks";
import { Rpc } from "./rpc";
import { loadSettings, saveSettings, type Settings } from "./settings";
import { Terminals } from "./terminals";
import { Tunnels } from "./tunnels";
import { Emitter, PEER_COLORS, randomString } from "./util";
import { YSync } from "./yjs-sync";

export interface Peer {
  name: string;
  role: Role;
  color: string;
  muted: boolean;
}

export interface Perms {
  /** Guest may type into terminals, open new ones, press Run and run notebook cells. */
  terminal: boolean;
}

export interface ChatMsg {
  id: number;
  from: string;
  color: string;
  mine: boolean;
  text: string;
  ts: number;
  system?: boolean;
}

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

/** Pointer / drawing messages on the unreliable `cursor` channel. */
export type PointerMsg =
  | { t: "p"; a: Anchor | null }
  | { t: "s"; id: number; tool: "laser" | "pen" | "highlighter"; i: number; a: Anchor; end?: boolean }
  | { t: "clear" };

/** A position expressed so it lands on the same thing on the peer's screen. */
export type Anchor =
  | { k: "code"; file: string; line: number; col: number }
  | { k: "el"; el: string; x: number; y: number };

type Events = {
  state: LinkState;
  peer: Peer | null;
  perms: Perms;
  chat: ChatMsg[];
  toast: Toast;
  doc: Y.Doc;
  stats: LinkStats;
  levels: Levels;
  audio: AudioState;
  pointer: PointerMsg;
  error: string;
};

export class Session extends Emitter<Events> {
  readonly link: Link;
  readonly bulk: Bulk;
  readonly rpc: Rpc;
  readonly audio: Audio;
  readonly files: Files;
  readonly terms: Terminals;
  readonly tunnels: Tunnels;
  readonly lsp: Lsp;
  readonly notebooks: Notebooks;
  readonly ysync: YSync;
  doc = new Y.Doc();
  awareness = new Awareness(this.doc);
  me: { name: string; color: string };
  peer: Peer | null = null;
  /** On by default: the student types in terminals and runs code; the host can lock it. */
  perms: Perms = { terminal: true };
  chat: ChatMsg[] = [];
  state: LinkState = "waiting";
  stats: LinkStats | null = null;
  /** Host: a new id each app start, so the guest can tell its history is stale. */
  sessionId = "";
  projectName = "";
  projectPath = "";
  projectKey = "";
  private nextId = 1;

  private constructor(
    readonly role: Role,
    readonly room: string,
    private sig: Signaling,
    settings: Settings,
  ) {
    super();
    this.me = { name: settings.name || (role === "host" ? "Teacher" : "Student"), color: PEER_COLORS[role === "host" ? 0 : 1] };
    this.audio = new Audio(settings);
    this.link = new Link(role, sig);
    this.rpc = new Rpc(this.link);
    this.bulk = new Bulk(this.link);
    this.ysync = new YSync(this.link, this.doc, this.awareness);
    this.files = new Files(this);
    this.terms = new Terminals(this);
    this.tunnels = new Tunnels(this);
    this.lsp = new Lsp(this);
    this.notebooks = new Notebooks(this);
    this.setAwarenessUser();
    this.wire();
  }

  static async host(settings: Settings, projectPath: string, room: string, roomKey: string) {
    const p = await invoke<{ name: string; path: string }>("project_open", { path: projectPath });
    const s = new Session("host", room, new Signaling(settings.signalingUrl, room, roomKey), settings);
    s.projectName = p.name;
    s.projectPath = p.path;
    s.projectKey = `${room}:${p.name}`;
    s.sessionId = randomString(12);
    // Terminals are guarded while the student may type (the default).
    await invoke("pty_guard", { on: s.perms.terminal }).catch(() => {});
    await s.begin();
    return s;
  }

  static async join(settings: Settings, room: string) {
    const s = new Session("guest", room, new Signaling(settings.signalingUrl, room), settings);
    await s.begin();
    return s;
  }

  private async begin() {
    this.lsp.init();
    const mix = await this.audio.startMic();
    if (!this.audio.state.micOk) this.toast("Microphone not available. You can still listen and chat.");
    this.link.start(mix);
  }

  private wire() {
    const { link, rpc } = this;
    link.on("state", (s) => {
      this.state = s;
      this.emit("state", s);
      if (s === "reconnecting" && this.peer) this.system(`Connection lost. Reconnecting…`);
    });
    // The partner left on purpose (Leave, or closed the window): say so, and
    // drop their cursor, pointer and drawings right away instead of waiting
    // for the connection to time out.
    rpc.on("leave", () => {
      const p = this.peer;
      if (!p) return;
      this.peer = null;
      this.ysync.dropPeer();
      this.emit("pointer", { t: "p", a: null });
      this.emit("pointer", { t: "clear" });
      this.emit("peer", null);
      this.system(`${p.name} left the lesson.`);
    });
    link.on("error", (e) => this.emit("error", e));
    link.on("stats", (st) => {
      this.stats = st;
      this.emit("stats", st);
    });
    link.on("remoteAudio", (stream) => this.audio.playRemote(stream));
    link.on("cursor", (m) => this.emit("pointer", m as PointerMsg));
    this.audio.on("levels", (l) => this.emit("levels", l));
    let wasMuted = this.audio.muted;
    this.audio.on("state", (a) => {
      // The partner's avatar shows "muted" when nothing at all reaches them.
      if (this.audio.muted !== wasMuted) {
        wasMuted = this.audio.muted;
        this.rpc.notify("mute", { muted: wasMuted });
      }
      // Device and volumes are remembered for the next lesson.
      saveSettings({ ...loadSettings(), micId: a.micId, micVolume: a.micVolume, sysVolume: a.sysVolume, outVolume: a.outVolume });
      this.emit("audio", a);
    });

    link.on("open", () => {
      rpc.notify("hello", {
        name: this.me.name,
        role: this.role,
        muted: this.audio.muted,
        sessionId: this.sessionId,
        project: this.projectName,
        perms: this.perms,
      });
    });

    rpc.on("hello", (p) => {
      const first = !this.peer;
      this.peer = { name: p.name, role: p.role, color: PEER_COLORS[p.role === "host" ? 0 : 1], muted: p.muted };
      if (this.role === "guest") {
        if (this.sessionId && this.sessionId !== p.sessionId) this.resetDoc();
        this.sessionId = p.sessionId;
        this.projectName = p.project;
        this.projectKey = `${this.room}:${p.project}`;
        this.perms = p.perms;
      }
      // Before any UI listener runs: one that throws must not leave the document unsynced.
      this.ysync.start();
      if (this.role === "guest") this.emit("perms", this.perms);
      this.emit("peer", this.peer);
      this.system(first ? `${p.name} joined.` : `${p.name} reconnected.`);
    });
    rpc.on("mute", ({ muted }) => {
      if (!this.peer) return;
      this.peer = { ...this.peer, muted };
      this.emit("peer", this.peer);
    });
    rpc.on("perms", (p: Perms) => {
      if (this.role !== "guest") return;
      const gained = p.terminal && !this.perms.terminal;
      this.perms = p;
      this.emit("perms", p);
      this.system(gained ? "The host gave you terminal access." : p.terminal ? "" : "Terminal access was turned off.");
    });
    rpc.on("chat", ({ text, ts }) => {
      if (!this.peer) return;
      this.push({ id: this.nextId++, from: this.peer.name, color: this.peer.color, mine: false, text: String(text).slice(0, 8000), ts });
    });
    rpc.on("preview", ({ port, path }) => {
      const p = this.tunnels.ports.find((x) => x.port === port);
      const local = p?.local ?? port;
      const url = `http://localhost:${local}/${String(path).split("/").map(encodeURIComponent).join("/")}`;
      this.toast(`${this.peer?.name ?? "Host"} opened ${path} in the browser.`, {
        label: "Open",
        run: () => void openUrl(url),
      });
    });
  }

  private setAwarenessUser() {
    this.awareness.setLocalStateField("user", { name: this.me.name, color: this.me.color });
  }

  /** Guest: the host restarted; old CRDT history must not be merged into the new one. */
  private resetDoc() {
    this.awareness.destroy();
    this.doc.destroy();
    this.doc = new Y.Doc();
    this.awareness = new Awareness(this.doc);
    this.setAwarenessUser();
    this.ysync.replace(this.doc, this.awareness);
    this.emit("doc", this.doc);
  }

  // ------------------------------------------------------------ actions ---

  setMuted(m: boolean) {
    this.audio.setMicMuted(m);
  }

  setPerms(p: Perms) {
    if (this.role !== "host") return;
    this.perms = p;
    void invoke("pty_guard", { on: p.terminal }).catch(() => {});
    this.emit("perms", p);
    this.rpc.notify("perms", p);
  }

  sendChat(text: string) {
    const t = text.trim();
    if (!t) return;
    const ts = Date.now();
    this.rpc.notify("chat", { text: t, ts });
    this.push({ id: this.nextId++, from: this.me.name, color: this.me.color, mine: true, text: t, ts });
  }

  sendPointer(m: PointerMsg) {
    this.link.sendCursor(m);
  }

  toast(text: string, action?: Toast["action"]) {
    this.emit("toast", { id: this.nextId++, text, action });
  }

  private system(text: string) {
    if (!text) return;
    this.push({ id: this.nextId++, from: "", color: "#888", mine: false, text, ts: Date.now(), system: true });
  }

  private push(m: ChatMsg) {
    this.chat = [...this.chat, m].slice(-500);
    this.emit("chat", this.chat);
  }

  /** Tell the partner we are going (before the link closes). */
  sayGoodbye() {
    this.rpc.notify("leave");
  }

  async leave(endRoom: boolean) {
    this.sayGoodbye();
    if (this.role === "host") {
      await invoke("pty_guard", { on: false }).catch(() => {});
      await this.files.flush().catch(() => {});
      await this.notebooks.flush().catch(() => {});
      for (const v of this.terms.list()) if (v.alive) await invoke("pty_kill", { id: v.id }).catch(() => {});
      if (endRoom) await this.sig.close();
    }
    this.link.close();
    this.lsp.dispose();
    this.notebooks.dispose();
    this.tunnels.dispose();
    this.audio.stop();
  }
}
