// Request/response and notifications over the control channel.
//   {t:"req", id, m, p}   ->   {t:"res", id, ok, v | e}
//   {t:"n", m, p}            fire-and-forget notification

import type { Link } from "../net/link";

type Handler = (p: any) => unknown | Promise<unknown>;

export class Rpc {
  private next = 1;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; timer: number }>();
  private handlers = new Map<string, Handler>();
  private listeners = new Map<string, Set<(p: any) => void>>();

  constructor(private link: Link) {
    link.on("ctrl", (msg) => this.onMessage(msg as any));
    link.on("state", (s) => {
      if (s !== "connected") this.failAll("disconnected");
    });
  }

  /** Serve a method the peer can call. Throwing sends the message back as an error. */
  handle(method: string, fn: Handler) {
    this.handlers.set(method, fn);
  }

  /** Listen for a notification. Returns an unsubscribe function. */
  on(method: string, fn: (p: any) => void) {
    let s = this.listeners.get(method);
    if (!s) this.listeners.set(method, (s = new Set()));
    s.add(fn);
    return () => s!.delete(fn);
  }

  notify(method: string, p?: unknown) {
    return this.link.sendCtrl({ t: "n", m: method, p });
  }

  call<T = any>(method: string, p?: unknown, timeoutMs = 30_000): Promise<T> {
    const id = this.next++;
    return new Promise<T>((res, rej) => {
      if (!this.link.sendCtrl({ t: "req", id, m: method, p })) return rej(new Error("not connected"));
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`${method}: timed out`));
      }, timeoutMs);
      this.pending.set(id, { res, rej, timer });
    });
  }

  private failAll(why: string) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.rej(new Error(why));
    }
    this.pending.clear();
  }

  private async onMessage(msg: { t: string; id?: number; m?: string; p?: unknown; ok?: boolean; v?: unknown; e?: string }) {
    if (msg.t === "res") {
      const p = this.pending.get(msg.id!);
      if (!p) return;
      this.pending.delete(msg.id!);
      clearTimeout(p.timer);
      msg.ok ? p.res(msg.v) : p.rej(new Error(msg.e));
    } else if (msg.t === "req") {
      const h = this.handlers.get(msg.m!);
      try {
        if (!h) throw new Error(`unknown method ${msg.m}`);
        const v = await h(msg.p);
        this.link.sendCtrl({ t: "res", id: msg.id, ok: true, v });
      } catch (e) {
        this.link.sendCtrl({ t: "res", id: msg.id, ok: false, e: e instanceof Error ? e.message : String(e) });
      }
    } else if (msg.t === "n") {
      this.listeners.get(msg.m!)?.forEach((fn) => fn(msg.p));
    }
  }
}
