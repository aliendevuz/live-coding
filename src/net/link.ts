// One peer-to-peer link between host and guest.
//
// Signaling (Lambda) is touched only to exchange one offer/answer; then all
// traffic flows over WebRTC. When the connection dies, the host publishes a
// fresh offer under a new epoch and the guest answers it again: that is the
// whole reconnect protocol.

import { Emitter, sleep } from "../core/util";
import { Signaling, SignalingError } from "./signaling";

export type Role = "host" | "guest";
export type LinkState = "waiting" | "connecting" | "connected" | "reconnecting" | "closed";

export interface LinkStats {
  rtt: number; // ms, from our own ping
  path: "direct" | "relay" | "unknown";
  sendRate: number; // bytes/s over the whole transport
  recvRate: number;
}

type Events = {
  state: LinkState;
  /** A new connection is up; every layer should resync. */
  open: void;
  ctrl: Record<string, unknown> & { t: string };
  yjs: Uint8Array;
  cursor: Record<string, unknown>;
  bulk: ArrayBuffer;
  term: ArrayBuffer;
  rtt: number;
  stats: LinkStats;
  remoteAudio: MediaStream;
  error: string;
};

const ICE: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];

// Negotiated channels: both sides create them with the same ids, so no
// ondatachannel round-trip and nothing extra to renegotiate.
const CHANNELS = {
  ctrl: { id: 0, ordered: true },
  yjs: { id: 1, ordered: true },
  cursor: { id: 2, ordered: false, maxRetransmits: 0 },
  bulk: { id: 3, ordered: true },
  term: { id: 4, ordered: true },
} as const;
type ChannelName = keyof typeof CHANNELS;

const HEARTBEAT_MS = 1000;
const CTRL_CHUNK = 60_000; // characters per control-channel message
const YJS_CHUNK = 60_000; // bytes per yjs-channel message
const DEAD_AFTER_MS = 10000;
const OPEN_TIMEOUT_MS = 25000;

export class Link extends Emitter<Events> {
  state: LinkState = "waiting";
  pc: RTCPeerConnection | null = null;
  private ch: Partial<Record<ChannelName, RTCDataChannel>> = {};
  private closed = false;
  private lastRx = 0;
  private fastPing = false;
  private mic: MediaStreamTrack | null = null;
  private lastAnsweredEpoch = "";
  private down: (() => void) | null = null;
  private everConnected = false;
  private nextChunkId = 1;
  private chunks = new Map<number, string[]>();
  private yjsChunks = new Map<number, Uint8Array[]>();

  constructor(
    readonly role: Role,
    private sig: Signaling,
  ) {
    super();
  }

  start(mic: MediaStreamTrack | null) {
    this.mic = mic;
    void (this.role === "host" ? this.runHost() : this.runGuest());
    void this.heartbeat();
    void this.statsLoop();
  }

  close() {
    if (this.closed) return;
    this.sendCtrl({ t: "bye" });
    this.closed = true;
    this.down?.();
    setTimeout(() => this.pc?.close(), 100);
    this.setState("closed");
  }

  /** Replace the microphone track without renegotiating. */
  setMic(track: MediaStreamTrack | null) {
    this.mic = track;
    const sender = this.pc?.getTransceivers()[0]?.sender;
    void sender?.replaceTrack(track);
  }

  /** Ping 4x a second while bulk traffic needs fresh RTT samples. */
  setFastPing(on: boolean) {
    this.fastPing = on;
  }

  channel(name: ChannelName): RTCDataChannel | null {
    const c = this.ch[name];
    return c && c.readyState === "open" ? c : null;
  }

  sendCtrl(msg: Record<string, unknown> & { t: string }): boolean {
    const c = this.channel("ctrl");
    if (!c) return false;
    const json = JSON.stringify(msg);
    if (json.length <= CTRL_CHUNK) {
      c.send(json);
      return true;
    }
    // Large messages (completion lists, big folder listings) are split: a data
    // channel message must stay well under the ~256 KB SCTP limit.
    const id = this.nextChunkId++;
    const n = Math.ceil(json.length / CTRL_CHUNK);
    for (let i = 0; i < n; i++) {
      c.send(JSON.stringify({ t: "chunk", id, i, n, d: json.slice(i * CTRL_CHUNK, (i + 1) * CTRL_CHUNK) }));
    }
    return true;
  }
  /**
   * Yjs updates can be large (a notebook output with a plot). Each message is
   * framed: [0][update] whole, or [1][id u32][index u16][count u16][part].
   */
  sendYjs(data: Uint8Array) {
    const c = this.channel("yjs");
    if (!c) return;
    if (data.length <= YJS_CHUNK) {
      const f = new Uint8Array(1 + data.length);
      f[0] = 0;
      f.set(data, 1);
      c.send(f);
      return;
    }
    const id = this.nextChunkId++;
    const n = Math.ceil(data.length / YJS_CHUNK);
    for (let i = 0; i < n; i++) {
      const part = data.subarray(i * YJS_CHUNK, (i + 1) * YJS_CHUNK);
      const f = new Uint8Array(9 + part.length);
      const v = new DataView(f.buffer);
      f[0] = 1;
      v.setUint32(1, id, true);
      v.setUint16(5, i, true);
      v.setUint16(7, n, true);
      f.set(part, 9);
      c.send(f);
    }
  }
  sendCursor(msg: Record<string, unknown>) {
    const c = this.channel("cursor");
    // Never queue pointer moves behind each other: stale ones are useless.
    if (c && c.bufferedAmount < 16 * 1024) c.send(JSON.stringify(msg));
  }

  private setState(s: LinkState) {
    if (this.state === s) return;
    this.state = s;
    this.emit("state", s);
  }

  // ---------------------------------------------------------------- setup ---

  private makePc(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    this.chunks.clear();
    this.yjsChunks.clear();
    this.pc = pc;
    this.ch = {};
    for (const [name, opts] of Object.entries(CHANNELS) as [ChannelName, RTCDataChannelInit][]) {
      const c = pc.createDataChannel(name, { ...opts, negotiated: true });
      c.binaryType = "arraybuffer";
      this.ch[name] = c;
      c.onmessage = (e) => this.onMessage(name, e.data);
      c.onclose = () => {
        if (this.pc === pc) this.down?.();
      };
    }
    this.ch.bulk!.bufferedAmountLowThreshold = 64 * 1024;
    this.ch.term!.bufferedAmountLowThreshold = 64 * 1024;
    pc.ontrack = (e) => this.emit("remoteAudio", e.streams[0] ?? new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return;
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.down?.();
    };
    return pc;
  }

  private onMessage(name: ChannelName, data: string | ArrayBuffer) {
    this.lastRx = Date.now();
    switch (name) {
      case "ctrl": {
        let msg = JSON.parse(data as string);
        if (msg.t === "chunk") {
          const parts = this.chunks.get(msg.id) ?? [];
          parts[msg.i] = msg.d;
          this.chunks.set(msg.id, parts);
          if (parts.filter((x) => x !== undefined).length < msg.n) break;
          this.chunks.delete(msg.id);
          msg = JSON.parse(parts.join(""));
        }
        if (msg.t === "ping") this.sendCtrl({ t: "pong", ts: msg.ts });
        else if (msg.t === "pong") this.emit("rtt", performance.now() - msg.ts);
        else if (msg.t === "bye") this.down?.();
        else this.emit("ctrl", msg);
        break;
      }
      case "yjs": {
        const f = new Uint8Array(data as ArrayBuffer);
        if (f[0] === 0) {
          this.emit("yjs", f.subarray(1));
          break;
        }
        const v = new DataView(f.buffer, f.byteOffset);
        const id = v.getUint32(1, true);
        const n = v.getUint16(7, true);
        const parts = this.yjsChunks.get(id) ?? [];
        parts[v.getUint16(5, true)] = f.slice(9);
        this.yjsChunks.set(id, parts);
        if (parts.filter(Boolean).length < n) break;
        this.yjsChunks.delete(id);
        const whole = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
        let off = 0;
        for (const p of parts) {
          whole.set(p, off);
          off += p.length;
        }
        this.emit("yjs", whole);
        break;
      }
      case "cursor":
        this.emit("cursor", JSON.parse(data as string));
        break;
      case "bulk":
        this.emit("bulk", data as ArrayBuffer);
        break;
      case "term":
        this.emit("term", data as ArrayBuffer);
        break;
    }
  }

  private waitIce(pc: RTCPeerConnection): Promise<void> {
    // Full candidate list inside the SDP, so one offer/answer is enough.
    // Capped: on machines with many adapters gathering can drag on.
    return new Promise((res) => {
      if (pc.iceGatheringState === "complete") return res();
      const t = setTimeout(res, 4000);
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(t);
          res();
        }
      });
    });
  }

  private waitOpen(pc: RTCPeerConnection): Promise<boolean> {
    const ctrl = this.ch.ctrl!;
    return new Promise((res) => {
      if (ctrl.readyState === "open") return res(true);
      const t = setTimeout(() => res(false), OPEN_TIMEOUT_MS);
      ctrl.addEventListener("open", () => {
        clearTimeout(t);
        res(true);
      });
      pc.addEventListener("connectionstatechange", () => {
        if (pc.connectionState === "failed") {
          clearTimeout(t);
          res(false);
        }
      });
    });
  }

  /** Resolves when the current connection is gone. */
  private waitDown(pc: RTCPeerConnection): Promise<void> {
    return new Promise((res) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(iv);
        this.down = null;
        res();
      };
      this.down = finish;
      let disconnectedSince = 0;
      const iv = setInterval(() => {
        if (this.closed || pc !== this.pc) return finish();
        if (pc.connectionState === "disconnected") {
          disconnectedSince ||= Date.now();
          if (Date.now() - disconnectedSince > 6000) return finish();
        } else disconnectedSince = 0;
        if (Date.now() - this.lastRx > DEAD_AFTER_MS) finish();
      }, 500);
    });
  }

  private async connected(pc: RTCPeerConnection) {
    this.lastRx = Date.now();
    this.everConnected = true;
    this.setState("connected");
    this.emit("open", undefined);
    await this.waitDown(pc);
    pc.close();
    if (!this.closed) this.setState("reconnecting");
  }

  private idleState(): LinkState {
    return this.everConnected ? "reconnecting" : "waiting";
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof SignalingError && e.status === 409) throw e;
        if (this.closed) throw e;
        this.emit("error", String(e));
        await sleep(Math.min(1000 * 2 ** i, 15000));
      }
    }
  }

  // ----------------------------------------------------------------- host ---

  private async runHost() {
    while (!this.closed) {
      this.setState(this.idleState());
      const pc = this.makePc();
      pc.addTransceiver(this.mic ?? "audio", { direction: "sendrecv" });
      await pc.setLocalDescription(await pc.createOffer());
      await this.waitIce(pc);
      const epoch = String(Date.now());
      try {
        await this.retry(() => this.sig.putOffer(epoch, pc.localDescription!.toJSON()));
      } catch (e) {
        this.emit("error", e instanceof SignalingError && e.status === 409 ? "Room code is taken by another host." : String(e));
        pc.close();
        if (this.closed) return;
        await sleep(5000);
        continue;
      }

      const started = Date.now();
      let answer = null;
      while (!answer && !this.closed) {
        answer = await this.sig.getAnswer(epoch).catch(() => null);
        if (!answer) await sleep(Date.now() - started < 120_000 ? 1000 : 2500);
      }
      if (!answer) return pc.close();

      this.setState("connecting");
      try {
        await pc.setRemoteDescription(answer.sdp);
      } catch (e) {
        this.emit("error", `bad answer: ${e}`);
        pc.close();
        continue;
      }
      if (!(await this.waitOpen(pc))) {
        this.emit("error", "Peer answered but no direct connection could be made (a TURN server may be needed).");
        pc.close();
        continue;
      }
      await this.connected(pc);
    }
  }

  // ---------------------------------------------------------------- guest ---

  private async runGuest() {
    while (!this.closed) {
      this.setState(this.idleState());
      let offer = null;
      while (!this.closed) {
        offer = await this.sig.getOffer().catch(() => null);
        if (offer && offer.epoch !== this.lastAnsweredEpoch) break;
        await sleep(1000);
      }
      if (!offer || this.closed) return;
      this.lastAnsweredEpoch = offer.epoch;

      this.setState("connecting");
      const pc = this.makePc();
      try {
        await pc.setRemoteDescription(offer.sdp);
        const tr = pc.getTransceivers()[0];
        if (tr) {
          tr.direction = "sendrecv";
          await tr.sender.replaceTrack(this.mic);
        }
        await pc.setLocalDescription(await pc.createAnswer());
        await this.waitIce(pc);
        await this.retry(() => this.sig.putAnswer(offer.epoch, pc.localDescription!.toJSON()));
      } catch (e) {
        // 409: someone answered first or the host moved on; wait for a new epoch.
        if (!(e instanceof SignalingError && e.status === 409)) this.emit("error", String(e));
        pc.close();
        await sleep(1000);
        continue;
      }
      if (!(await this.waitOpen(pc))) {
        pc.close();
        continue;
      }
      await this.connected(pc);
    }
  }

  // ------------------------------------------------------------ liveness ---

  private async heartbeat() {
    let last = 0;
    while (!this.closed) {
      await sleep(250);
      const now = performance.now();
      if (now - last >= (this.fastPing ? 250 : HEARTBEAT_MS)) {
        last = now;
        this.sendCtrl({ t: "ping", ts: now });
      }
    }
  }

  private async statsLoop() {
    let prev: { sent: number; recv: number; at: number } | null = null;
    while (!this.closed) {
      await sleep(2000);
      const pc = this.pc;
      if (!pc || this.state !== "connected") {
        prev = null;
        continue;
      }
      try {
        const report = await pc.getStats();
        let pair: RTCIceCandidatePairStats | undefined;
        report.forEach((s) => {
          if (s.type === "candidate-pair" && (s as RTCIceCandidatePairStats).nominated && s.state === "succeeded") {
            pair = s as RTCIceCandidatePairStats;
          }
        });
        if (!pair) continue;
        const local = report.get(pair.localCandidateId) as { candidateType?: string } | undefined;
        const remote = report.get(pair.remoteCandidateId) as { candidateType?: string } | undefined;
        const relay = local?.candidateType === "relay" || remote?.candidateType === "relay";
        const now = performance.now();
        const sent = pair.bytesSent ?? 0;
        const recv = pair.bytesReceived ?? 0;
        let sendRate = 0;
        let recvRate = 0;
        if (prev) {
          const dt = (now - prev.at) / 1000;
          sendRate = Math.max(0, (sent - prev.sent) / dt);
          recvRate = Math.max(0, (recv - prev.recv) / dt);
        }
        prev = { sent, recv, at: now };
        this.emit("stats", {
          rtt: (pair.currentRoundTripTime ?? 0) * 1000,
          path: local ? (relay ? "relay" : "direct") : "unknown",
          sendRate,
          recvRate,
        });
      } catch {
        /* stats are best effort */
      }
    }
  }
}
