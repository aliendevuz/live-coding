// Port forwarding: the host shares localhost ports, the guest gets the same
// port on its own localhost. Each TCP connection is a bulk stream (the guest's
// connection id) carrying TunOpen / TunData / TunClose frames in order.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Kind, type Frame } from "../net/bulk";
import type { Session } from "./session";
import { Emitter, SerialQueue } from "./util";

export interface SharedPort {
  port: number;
  /** Guest: where it is reachable locally (usually the same number). */
  local?: number;
}

type Events = { ports: SharedPort[] };

interface Conn {
  local: number | null; // Rust connection id on this machine (host: after connect)
  queue: SerialQueue;
  backlog: Uint8Array[]; // host: peer data that arrived before the connect finished
  early: ArrayBuffer[]; // host: socket data read before we learned the Rust id
  closed: boolean;
}

export class Tunnels extends Emitter<Events> {
  ports: SharedPort[] = [];
  private conns = new Map<number, Conn>(); // by stream id
  private byLocal = new Map<number, number>(); // Rust id -> stream id

  constructor(private s: Session) {
    super();
    s.bulk.on("frame", (f) => this.onFrame(f));
    s.bulk.on("reset", () => this.resetConns());
    void listen<{ id: number }>("tunnel-closed", (e) => this.onLocalClosed(e.payload.id));
    if (s.role === "host") {
      s.link.on("open", () => this.announce());
    } else {
      s.rpc.on("ports", (ports: number[]) => void this.applyPorts(ports));
      void listen<{ id: number; port: number }>("tunnel-accept", (e) => void this.onAccept(e.payload.id, e.payload.port));
    }
  }

  // ------------------------------------------------------------------ host ---

  share(port: number) {
    if (this.ports.some((p) => p.port === port)) return;
    this.ports = [...this.ports, { port }].sort((a, b) => a.port - b.port);
    this.announce();
  }

  unshare(port: number) {
    this.ports = this.ports.filter((p) => p.port !== port);
    this.announce();
  }

  private announce() {
    this.emit("ports", this.ports);
    this.s.rpc.notify("ports", this.ports.map((p) => p.port));
  }

  private async hostOpen(stream: number, port: number) {
    const conn: Conn = { local: null, queue: new SerialQueue(), backlog: [], early: [], closed: false };
    this.conns.set(stream, conn);
    if (!this.ports.some((p) => p.port === port)) {
      this.s.bulk.send(Kind.TunClose, stream);
      this.conns.delete(stream);
      return;
    }
    try {
      conn.local = await invoke<number>("tunnel_connect", { port, onData: this.reader(stream) });
    } catch {
      this.s.bulk.send(Kind.TunClose, stream);
      this.conns.delete(stream);
      return;
    }
    this.byLocal.set(conn.local, stream);
    if (conn.closed) return void invoke("tunnel_close", { id: conn.local });
    for (const b of conn.backlog) this.write(conn, b);
    conn.backlog = [];
    for (const b of conn.early) this.forward(stream, conn.local, b);
    conn.early = [];
  }

  // ----------------------------------------------------------------- guest ---

  private async applyPorts(ports: number[]) {
    const old = new Map(this.ports.map((p) => [p.port, p]));
    const next: SharedPort[] = [];
    for (const port of ports) {
      const have = old.get(port);
      if (have) {
        next.push(have);
        old.delete(port);
        continue;
      }
      try {
        const local = await invoke<number>("tunnel_listen", { port });
        next.push({ port, local });
      } catch (e) {
        this.s.toast(`Could not open local port for ${port}: ${e}`);
      }
    }
    for (const gone of old.keys()) void invoke("tunnel_unlisten", { port: gone });
    this.ports = next;
    this.emit("ports", this.ports);
  }

  private async onAccept(id: number, port: number) {
    const conn: Conn = { local: id, queue: new SerialQueue(), backlog: [], early: [], closed: false };
    this.conns.set(id, conn);
    this.byLocal.set(id, id);
    const p = new Uint8Array(2);
    new DataView(p.buffer).setUint16(0, port, true);
    this.s.bulk.send(Kind.TunOpen, id, p);
    try {
      await invoke("tunnel_attach", { id, onData: this.reader(id) });
    } catch {
      this.closeStream(id, true);
    }
  }

  // ---------------------------------------------------------------- common ---

  /** Channel for bytes read from the local socket: forward them as bulk frames. */
  private reader(stream: number) {
    const ch = new Channel<ArrayBuffer>();
    ch.onmessage = (buf) => {
      const conn = this.conns.get(stream);
      if (!conn) return;
      if (conn.local == null) conn.early.push(buf);
      else this.forward(stream, conn.local, buf);
    };
    return ch;
  }

  private forward(stream: number, id: number, buf: ArrayBuffer) {
    // Return the read credit only once the chunk has left over WebRTC.
    this.s.bulk.send(Kind.TunData, stream, new Uint8Array(buf), () => void invoke("tunnel_ack", { id, n: 1 }));
  }

  private write(conn: Conn, bytes: Uint8Array) {
    const id = conn.local!;
    void conn.queue.run(() =>
      invoke("tunnel_write", bytes, { headers: { "x-id": String(id) } }).catch(() => {}),
    );
  }

  private onFrame(f: Frame) {
    switch (f.kind) {
      case Kind.TunOpen:
        if (this.s.role === "host") void this.hostOpen(f.stream, new DataView(f.payload.buffer, f.payload.byteOffset).getUint16(0, true));
        break;
      case Kind.TunData: {
        const conn = this.conns.get(f.stream);
        if (!conn) return;
        const bytes = f.payload.slice();
        if (conn.local == null) conn.backlog.push(bytes);
        else this.write(conn, bytes);
        break;
      }
      case Kind.TunClose:
        this.closeStream(f.stream, false);
        break;
    }
  }

  /** The local socket ended: tell the peer, then release ours. */
  private onLocalClosed(localId: number) {
    const stream = this.byLocal.get(localId);
    if (stream != null) this.closeStream(stream, true);
  }

  private closeStream(stream: number, tellPeer: boolean) {
    const conn = this.conns.get(stream);
    if (!conn) return;
    conn.closed = true;
    this.conns.delete(stream);
    if (tellPeer) this.s.bulk.send(Kind.TunClose, stream);
    if (conn.local != null) {
      this.byLocal.delete(conn.local);
      const id = conn.local;
      // Close after queued writes, so the response's tail is not cut off.
      void conn.queue.run(() => invoke("tunnel_close", { id }));
    }
  }

  private resetConns() {
    for (const stream of [...this.conns.keys()]) this.closeStream(stream, false);
  }

  /** Session over: drop listeners and connections. */
  dispose() {
    this.resetConns();
    void invoke("tunnel_reset");
  }
}
