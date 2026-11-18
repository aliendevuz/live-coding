// Bulk lane: file transfers and port-forwarded TCP share one reliable data
// channel, behind a rate limiter that keeps interactive traffic (audio,
// pointer, typing, terminal, chat) responsive.
//
// Rate control is delay based: we watch the ping RTT on the control channel.
// While it stays near the idle baseline, bulk speeds up; when queueing delay
// appears (bulk is starting to hurt everything else), bulk is cut to at most
// half of what the link is currently carrying. So bulk never takes the link
// from interactive traffic, and uses the whole link when nobody else needs it.

import { Emitter, sleep } from "../core/util";
import type { Link } from "./link";

export enum Kind {
  FileData = 1,
  FileEnd = 2,
  FileErr = 3,
  TunOpen = 10,
  TunData = 11,
  TunClose = 12,
}

export interface Frame {
  kind: Kind;
  stream: number;
  payload: Uint8Array;
}

interface Item {
  frame: Uint8Array;
  onSent?: () => void;
}

const MAX_FRAME = 16 * 1024;
const HIGH_WATER = 256 * 1024;
const MIN_RATE = 32 * 1024;
const MAX_RATE = 100 * 1024 * 1024;
const QUEUE_DELAY_CUT_MS = 80;
const QUEUE_DELAY_OK_MS = 30;

type Events = { frame: Frame; reset: void };

export class Bulk extends Emitter<Events> {
  rate = 512 * 1024; // bytes/s allowed for bulk
  sentRate = 0; // bytes/s actually sent (for the status bar)
  private queues = new Map<number, Item[]>();
  private queuedBytes = new Map<number, number>();
  private rr: number[] = [];
  private tokens = 0;
  private lastRefill = performance.now();
  private pumping = false;
  private rttSamples: { at: number; rtt: number }[] = [];
  private lastCut = 0;
  private limitedByRate = false;
  private linkRate = 0;
  private sentWindow = 0;
  private sentWindowAt = performance.now();
  private drainWaiters: { stream: number; max: number; res: () => void }[] = [];

  constructor(private link: Link) {
    super();
    link.on("bulk", (buf) => {
      const v = new DataView(buf);
      this.emit("frame", { kind: v.getUint8(0), stream: v.getUint32(1, true), payload: new Uint8Array(buf, 5) });
    });
    link.on("open", () => this.reset());
    link.on("state", (s) => s !== "connected" && this.reset());
    link.on("rtt", (rtt) => this.onRtt(rtt));
    link.on("stats", (s) => (this.linkRate = s.sendRate));
  }

  /** Queue one frame. Payloads larger than a frame are split. */
  send(kind: Kind, stream: number, payload?: Uint8Array, onSent?: () => void) {
    const data = payload ?? new Uint8Array(0);
    let off = 0;
    do {
      const n = Math.min(MAX_FRAME, data.length - off);
      const f = new Uint8Array(5 + n);
      const v = new DataView(f.buffer);
      v.setUint8(0, kind);
      v.setUint32(1, stream, true);
      f.set(data.subarray(off, off + n), 5);
      off += n;
      const last = off >= data.length;
      this.enqueue(stream, { frame: f, onSent: last ? onSent : undefined });
    } while (off < data.length);
  }

  /** Bytes still queued for a stream. */
  queued(stream: number) {
    return this.queuedBytes.get(stream) ?? 0;
  }

  /** Resolve once a stream's queue is at or below `max` bytes. */
  waitQueued(stream: number, max: number): Promise<void> {
    if (this.queued(stream) <= max) return Promise.resolve();
    return new Promise((res) => this.drainWaiters.push({ stream, max, res }));
  }

  busy() {
    return this.rr.length > 0;
  }

  /** Drop a stream's pending frames (transfer cancelled). */
  drop(stream: number) {
    this.queues.delete(stream);
    this.queuedBytes.delete(stream);
    this.rr = this.rr.filter((s) => s !== stream);
    this.notifyDrain();
  }

  private enqueue(stream: number, item: Item) {
    let q = this.queues.get(stream);
    if (!q) {
      this.queues.set(stream, (q = []));
      this.rr.push(stream);
    }
    q.push(item);
    this.queuedBytes.set(stream, this.queued(stream) + item.frame.length);
    this.link.setFastPing(true);
    void this.pump();
  }

  private reset() {
    this.queues.clear();
    this.queuedBytes.clear();
    this.rr = [];
    this.notifyDrain(true);
    this.emit("reset", undefined);
  }

  private notifyDrain(all = false) {
    this.drainWaiters = this.drainWaiters.filter((w) => {
      if (all || this.queued(w.stream) <= w.max) {
        w.res();
        return false;
      }
      return true;
    });
  }

  private refill() {
    const now = performance.now();
    const burst = Math.max(MAX_FRAME * 2, this.rate * 0.05);
    this.tokens = Math.min(burst, this.tokens + ((now - this.lastRefill) / 1000) * this.rate);
    this.lastRefill = now;
  }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.rr.length) {
        const dc = this.link.channel("bulk");
        if (!dc) break;
        if (dc.bufferedAmount > HIGH_WATER) {
          this.limitedByRate = false;
          await new Promise<void>((res) => {
            const t = setTimeout(res, 200);
            dc.addEventListener(
              "bufferedamountlow",
              () => {
                clearTimeout(t);
                res();
              },
              { once: true },
            );
          });
          continue;
        }
        const stream = this.rr[0];
        const q = this.queues.get(stream)!;
        const item = q[0];
        this.refill();
        if (this.tokens < item.frame.length) {
          this.limitedByRate = true;
          await sleep(Math.max(2, ((item.frame.length - this.tokens) / this.rate) * 1000));
          continue;
        }
        this.tokens -= item.frame.length;
        q.shift();
        dc.send(item.frame as Uint8Array<ArrayBuffer>);
        this.countSent(item.frame.length);
        this.queuedBytes.set(stream, this.queued(stream) - item.frame.length);
        // Round robin: move this stream to the back, or drop it if empty.
        this.rr.shift();
        if (q.length) this.rr.push(stream);
        else {
          this.queues.delete(stream);
          this.queuedBytes.delete(stream);
        }
        item.onSent?.();
        this.notifyDrain();
      }
    } finally {
      this.pumping = false;
      if (!this.rr.length) this.link.setFastPing(false);
    }
  }

  private countSent(n: number) {
    this.sentWindow += n;
    const now = performance.now();
    if (now - this.sentWindowAt > 1000) {
      this.sentRate = (this.sentWindow / (now - this.sentWindowAt)) * 1000;
      this.sentWindow = 0;
      this.sentWindowAt = now;
    }
  }

  private onRtt(rtt: number) {
    const now = performance.now();
    this.rttSamples.push({ at: now, rtt });
    this.rttSamples = this.rttSamples.filter((s) => now - s.at < 30_000);
    if (!this.busy()) {
      if (now - this.sentWindowAt > 2000) this.sentRate = 0;
      return;
    }
    const base = Math.min(...this.rttSamples.map((s) => s.rtt));
    const queueDelay = rtt - base;
    if (queueDelay > QUEUE_DELAY_CUT_MS) {
      if (now - this.lastCut > Math.max(rtt, 250)) {
        this.lastCut = now;
        const half = this.linkRate > 0 ? this.linkRate / 2 : this.rate / 2;
        this.rate = Math.max(MIN_RATE, Math.min(this.rate * 0.7, half));
      }
    } else if (queueDelay < QUEUE_DELAY_OK_MS && this.limitedByRate) {
      this.rate = Math.min(MAX_RATE, this.rate * 1.1 + 16 * 1024);
    }
  }
}
