/** Tiny typed event emitter. */
export class Emitter<E extends Record<string, unknown>> {
  /** Type-only marker so helpers can recover the event map. */
  declare readonly __events?: E;
  private handlers = new Map<keyof E, Set<(v: never) => void>>();
  on<K extends keyof E>(k: K, fn: (v: E[K]) => void): () => void {
    let s = this.handlers.get(k);
    if (!s) this.handlers.set(k, (s = new Set()));
    s.add(fn as (v: never) => void);
    return () => s!.delete(fn as (v: never) => void);
  }
  emit<K extends keyof E>(k: K, v: E[K]) {
    this.handlers.get(k)?.forEach((fn) => (fn as (v: E[K]) => void)(v));
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function randomString(len: number, alphabet = "abcdefghjkmnpqrstuvwxyz23456789"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Runs async jobs one after another (keeps IPC writes in order). */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(job: () => Promise<T>): Promise<T> {
    const p = this.tail.then(job, job);
    this.tail = p.catch(() => {});
    return p;
  }
}

// Saturated, Figma-like: white text stays readable on every one.
export const PEER_COLORS = ["#7B61FF", "#0D99FF", "#F24822", "#14AE5C", "#FF24BD", "#FFA629"];

export function basename(p: string) {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}
export function dirname(p: string) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
export function joinPath(dir: string, name: string) {
  return dir ? `${dir}/${name}` : name;
}

/** Percent-encode for IPC headers (Rust side decodes). */
export const headerSafe = (s: string) => encodeURIComponent(s).replace(/%2F/g, "/");
