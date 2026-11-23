// Yjs document + awareness sync over the `yjs` data channel (y-protocols).
// Message = [type varuint][payload]: 0 = sync, 1 = awareness.

import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { Link } from "../net/link";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
/** At most one repair request per this long. */
const RESYNC_GAP_MS = 2000;

export class YSync {
  private started = false;
  private early: Uint8Array[] = [];
  private remoteClients = new Set<number>();
  private offDoc: (() => void) | null = null;
  private lastResync = 0;
  private resyncTimer = 0;

  constructor(
    private link: Link,
    public doc: Y.Doc,
    public awareness: awarenessProtocol.Awareness,
  ) {
    link.on("yjs", (data) => (this.started ? this.safeReceive(data) : this.early.push(data)));
    link.on("state", (s) => {
      if (s !== "connected") {
        this.started = false;
        this.early = [];
        this.dropRemoteAwareness();
      }
    });
    this.bind();
  }

  /** Switch to a fresh document (the host restarted and history no longer matches). */
  replace(doc: Y.Doc, awareness: awarenessProtocol.Awareness) {
    this.offDoc?.();
    this.remoteClients.clear();
    this.doc = doc;
    this.awareness = awareness;
    this.bind();
  }

  /** Call once both sides have exchanged hello on a new connection. */
  start() {
    this.started = true;
    this.sendStep1();
    this.sendAwareness([this.doc.clientID]);
    const queued = this.early;
    this.early = [];
    queued.forEach((d) => this.safeReceive(d));
  }

  /**
   * Ask the peer for everything we lack. The peer answers with one update
   * computed from our state vector, which also fills any gap that left later
   * updates stuck as "pending" (Yjs applies a client's changes strictly in order).
   */
  resync() {
    if (!this.started) return;
    const wait = this.lastResync + RESYNC_GAP_MS - Date.now();
    if (wait > 0) {
      if (!this.resyncTimer) this.resyncTimer = window.setTimeout(() => ((this.resyncTimer = 0), this.resync()), wait);
      return;
    }
    this.sendStep1();
  }

  /** Some received changes are waiting for ones that never arrived. */
  get stuck(): boolean {
    return !!(this.doc.store.pendingStructs || this.doc.store.pendingDs);
  }

  private sendStep1() {
    this.lastResync = Date.now();
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    this.link.sendYjs(encoding.toUint8Array(enc));
  }

  /** A throwing observer must not stop the sync (or the peer's next message). */
  private safeReceive(data: Uint8Array) {
    try {
      this.receive(data);
    } catch (e) {
      console.error("yjs: message failed", e);
    }
    if (this.stuck) this.resync();
  }

  private bind() {
    const onUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === this || !this.started) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.link.sendYjs(encoding.toUint8Array(enc));
    };
    const onAwareness = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ) => {
      if (origin === this || !this.started) return;
      this.sendAwareness([...added, ...updated, ...removed]);
    };
    this.doc.on("update", onUpdate);
    this.awareness.on("update", onAwareness);
    this.offDoc = () => {
      this.doc.off("update", onUpdate);
      this.awareness.off("update", onAwareness);
    };
  }

  private sendAwareness(clients: number[]) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
    this.link.sendYjs(encoding.toUint8Array(enc));
  }

  private receive(data: Uint8Array) {
    const dec = decoding.createDecoder(data);
    const type = decoding.readVarUint(dec);
    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.readSyncMessage(dec, enc, this.doc, this);
      if (encoding.length(enc) > 1) this.link.sendYjs(encoding.toUint8Array(enc));
    } else if (type === MSG_AWARENESS) {
      const update = decoding.readVarUint8Array(dec);
      // Remember which clients came from the peer so we can clear them on disconnect.
      const d2 = decoding.createDecoder(update);
      const n = decoding.readVarUint(d2);
      for (let i = 0; i < n; i++) {
        const id = decoding.readVarUint(d2);
        decoding.readVarUint(d2); // clock
        decoding.readVarString(d2); // state json
        if (id !== this.doc.clientID) this.remoteClients.add(id);
      }
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, this);
    }
  }

  private dropRemoteAwareness() {
    if (this.remoteClients.size) {
      awarenessProtocol.removeAwarenessStates(this.awareness, [...this.remoteClients], this);
      this.remoteClients.clear();
    }
  }
}

export { Y };
