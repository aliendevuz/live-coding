// The partner's mouse pointer, plus laser / pen / highlighter drawing.
//
// Positions are sent as anchors, not pixels: over code they are (file, line,
// column), elsewhere a fraction of a named panel. So a stroke drawn under
// line 12 stays under line 12 on the other screen, and scrolls with the code.

import { useEffect, useRef, useState } from "react";
import { Highlighter, PenLine, Zap } from "lucide-react";
import type { Anchor, PointerMsg, Session } from "../core/session";
import { codeToPoint, codeToPointRaw, pointToCode } from "./editor-registry";

export type Tool = "laser" | "pen" | "highlighter" | null;

interface Pt {
  a: Anchor;
  t: number;
}
interface Stroke {
  id: string;
  tool: "laser" | "pen" | "highlighter";
  color: string;
  pts: (Pt | undefined)[];
  last: number;
  ended: boolean;
}

const LASER_FADE_MS = 1200;

type P = { x: number; y: number };

/** Chaikin corner cutting: turns a sampled polyline into a smooth curve. */
function smooth(pts: P[], rounds = 2): P[] {
  let out = pts;
  for (let r = 0; r < rounds && out.length > 2; r++) {
    const next: P[] = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i];
      const b = out[i + 1];
      next.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y }, { x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

/** Screen points of a stroke, split where a point is missing or off screen. */
function runsOf(s: Stroke, now: number, maxAge = Infinity): { p: P; age: number }[][] {
  const runs: { p: P; age: number }[][] = [];
  let run: { p: P; age: number }[] = [];
  for (const pt of s.pts) {
    // A point lost on the unreliable channel is simply bridged.
    if (!pt) continue;
    const age = now - pt.t;
    const q = age <= maxAge ? fromAnchor(pt.a) : null;
    if (!q) {
      if (run.length) runs.push(run);
      run = [];
      continue;
    }
    run.push({ p: q, age });
  }
  if (run.length) runs.push(run);
  return runs;
}

function tracePath(ctx: CanvasRenderingContext2D, pts: P[]) {
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
}

/**
 * Pen and highlighter: one path per run, so a translucent highlighter never
 * darkens where segments meet. Laser: opaque, tapering by age, drawn on its
 * own canvas and composited with a glow, so it fades as one smooth trail.
 */
function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, now: number, laser: HTMLCanvasElement) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (s.tool === "pen" || s.tool === "highlighter") {
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.strokeStyle = s.tool === "pen" ? s.color : "rgba(255, 221, 0, 0.32)";
    ctx.lineWidth = s.tool === "pen" ? 3 : 20;
    for (const run of runsOf(s, now)) {
      ctx.beginPath();
      tracePath(ctx, smooth(run.map((r) => r.p)));
      ctx.stroke();
    }
    return;
  }
  const runs = runsOf(s, now, LASER_FADE_MS).filter((r) => r.length);
  if (!runs.length) return;
  const dpr = devicePixelRatio || 1;
  if (laser.width !== innerWidth * dpr || laser.height !== innerHeight * dpr) {
    laser.width = innerWidth * dpr;
    laser.height = innerHeight * dpr;
  }
  const lc = laser.getContext("2d")!;
  lc.setTransform(dpr, 0, 0, dpr, 0, 0);
  lc.clearRect(0, 0, innerWidth, innerHeight);
  lc.lineCap = "round";
  lc.lineJoin = "round";
  lc.strokeStyle = "#ff3b3b";
  for (const run of runs) {
    // Smooth the positions, carry each point's age along by index.
    const pts = smooth(run.map((r) => r.p));
    const ageAt = (i: number) => run[Math.min(run.length - 1, Math.round((i / Math.max(1, pts.length - 1)) * (run.length - 1)))].age;
    for (let i = 1; i < pts.length; i++) {
      const life = 1 - ageAt(i) / LASER_FADE_MS;
      if (life <= 0) continue;
      lc.lineWidth = 1 + 4 * life; // the tail thins out instead of turning into dots
      lc.beginPath();
      lc.moveTo(pts[i - 1].x, pts[i - 1].y);
      lc.lineTo(pts[i].x, pts[i].y);
      lc.stroke();
    }
    if (pts.length === 1) {
      lc.beginPath();
      lc.arc(pts[0].x, pts[0].y, 2.5, 0, Math.PI * 2);
      lc.fillStyle = "#ff3b3b";
      lc.fill();
    }
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = s.ended ? Math.max(0, 1 - (now - s.last) / LASER_FADE_MS) : 1;
  ctx.shadowColor = "rgba(255, 30, 30, 0.9)";
  ctx.shadowBlur = 10 * dpr;
  ctx.drawImage(laser, 0, 0);
  ctx.restore();
}
const SEND_HZ = 40;

function toAnchor(x: number, y: number): Anchor | null {
  const code = pointToCode(x, y);
  if (code) return { k: "code", ...code };
  for (const el of document.elementsFromPoint(x, y)) {
    const host = (el as HTMLElement).closest?.("[data-anchor]") as HTMLElement | null;
    if (!host) continue;
    const r = host.getBoundingClientRect();
    return { k: "el", el: host.dataset.anchor!, x: (x - r.left) / r.width, y: (y - r.top) / r.height };
  }
  return { k: "el", el: "window", x: x / innerWidth, y: y / innerHeight };
}

const PANE_NAMES: Record<string, string> = {
  explorer: "Explorer",
  panel: "Terminal panel",
  terminal: "Terminal",
  chat: "Chat",
  notebook: "Notebook",
  editor: "Editor",
  tabs: "Editor",
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Where to draw the partner's pointer. Unlike strokes, the pointer never just
 * disappears: if it points at something we cannot see, it is docked at the
 * nearest edge with a hint ("line 120", "in main.py", "in Terminal").
 */
function pointerTarget(a: Anchor): { x: number; y: number; hint: string } | null {
  if (a.k === "code") {
    const raw = codeToPointRaw(a);
    const wrap = document.querySelector(".editor-wrap")?.getBoundingClientRect();
    if (!raw) {
      if (!wrap) return null;
      return { x: wrap.left + 28, y: wrap.top + 16, hint: `in ${a.file.split("/").pop()}` };
    }
    const b = raw.box;
    const line = Math.floor(a.line);
    if (raw.y < b.top - 2) return { x: clamp(raw.x, b.left, b.right - 30), y: b.top + 4, hint: `↑ line ${line}` };
    if (raw.y > b.bottom + 2) return { x: clamp(raw.x, b.left, b.right - 30), y: b.bottom - 28, hint: `↓ line ${line}` };
    if (raw.x > b.right + 2) return { x: b.right - 30, y: raw.y, hint: `→ column ${Math.round(a.col) + 1}` };
    if (raw.x < b.left - 30) return { x: b.left + 2, y: raw.y, hint: `← column ${Math.round(a.col) + 1}` };
    return { x: raw.x, y: raw.y, hint: "" };
  }
  const p = fromAnchor(a);
  if (p) return { ...p, hint: "" };
  // The element is hidden on our screen (closed pane, other notebook cell...).
  const name = a.el.startsWith("cell-") ? "a notebook cell" : (PANE_NAMES[a.el] ?? a.el);
  const hint = `in ${name} (hidden here)`;
  if (a.el === "explorer") return { x: 6, y: innerHeight / 2, hint };
  if (a.el === "chat") return { x: innerWidth - 190, y: innerHeight / 2, hint };
  if (a.el === "panel" || a.el === "terminal") return { x: innerWidth / 2, y: innerHeight - 60, hint };
  const wrap = document.querySelector(".editor-wrap")?.getBoundingClientRect();
  return wrap ? { x: wrap.left + 28, y: wrap.top + 16, hint } : null;
}

function fromAnchor(a: Anchor): { x: number; y: number } | null {
  if (a.k === "code") return codeToPoint(a);
  if (a.el === "window") return { x: a.x * innerWidth, y: a.y * innerHeight };
  const host = document.querySelector(`[data-anchor="${a.el}"]`);
  if (!host) return null;
  const r = host.getBoundingClientRect();
  if (!r.width) return null;
  return { x: r.left + a.x * r.width, y: r.top + a.y * r.height };
}

interface Props {
  session: Session;
  tool: Tool;
  setTool: (t: Tool) => void;
  myColor: string;
  peerColor: string;
  peerName: string;
}

export function PointerOverlay({ session, tool, setTool, myColor, peerColor, peerName }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLSpanElement>(null);
  const strokes = useRef(new Map<string, Stroke>());
  const remoteAnchor = useRef<Anchor | null>(null);
  const [peerTool, setPeerTool] = useState<Stroke["tool"] | null>(null);
  const peerToolTimer = useRef(0);
  const toolRef = useRef(tool);
  toolRef.current = tool;

  // ---- send my pointer ----
  useEffect(() => {
    let last = 0;
    let pending: { x: number; y: number } | null = null;
    let timer = 0;
    const flush = () => {
      timer = 0;
      if (!pending) return;
      last = performance.now();
      session.sendPointer({ t: "p", a: toAnchor(pending.x, pending.y) });
      pending = null;
    };
    const onMove = (e: MouseEvent) => {
      pending = { x: e.clientX, y: e.clientY };
      const wait = 1000 / SEND_HZ - (performance.now() - last);
      if (wait <= 0) flush();
      else if (!timer) timer = window.setTimeout(flush, wait);
    };
    const onLeave = () => session.sendPointer({ t: "p", a: null });
    window.addEventListener("mousemove", onMove, { passive: true });
    document.documentElement.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      clearTimeout(timer);
    };
  }, [session]);

  // ---- receive ----
  useEffect(() => {
    return session.on("pointer", (m: PointerMsg) => {
      if (m.t === "p") {
        remoteAnchor.current = m.a;
      } else if (m.t === "s") {
        const key = `r${m.id}`;
        let s = strokes.current.get(key);
        if (!s) {
          s = { id: key, tool: m.tool, color: peerColor, pts: [], last: 0, ended: false };
          strokes.current.set(key, s);
        }
        s.pts[m.i] = { a: m.a, t: performance.now() };
        // While the peer draws, their cursor follows the pen tip and shows the tool.
        remoteAnchor.current = m.a;
        setPeerTool(m.tool);
        clearTimeout(peerToolTimer.current);
        peerToolTimer.current = window.setTimeout(() => setPeerTool(null), 1500);
        s.last = performance.now();
        if (m.end) s.ended = true;
      } else if (m.t === "clear") {
        strokes.current.clear();
      }
    });
  }, [session, peerColor]);

  // ---- keyboard: tools ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && toolRef.current) {
        setTool(null);
        return;
      }
      if (!(e.ctrlKey && e.altKey)) return;
      const k = e.key.toLowerCase();
      const map: Record<string, Tool> = { l: "laser", p: "pen", h: "highlighter" };
      if (k in map) {
        e.preventDefault();
        setTool(toolRef.current === map[k] ? null : map[k]);
      } else if (k === "c") {
        e.preventDefault();
        strokes.current.clear();
        session.sendPointer({ t: "clear" });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [session, setTool]);

  // ---- drawing input ----
  useEffect(() => {
    const cv = canvasRef.current!;
    let cur: Stroke | null = null;
    let seq = 0;
    let lastSent = 0;
    const add = (e: PointerEvent, end = false) => {
      if (!cur) return;
      const a = toAnchor(e.clientX, e.clientY);
      if (!a) return;
      const now = performance.now();
      const i = cur.pts.length;
      cur.pts.push({ a, t: now });
      cur.last = now;
      if (end || now - lastSent >= 1000 / 60) {
        lastSent = now;
        session.sendPointer({ t: "s", id: Number(cur.id.slice(1)), tool: cur.tool, i, a, end });
      }
    };
    const down = (e: PointerEvent) => {
      if (!toolRef.current) return;
      cv.setPointerCapture(e.pointerId);
      seq = (seq + 1) % 1_000_000;
      cur = { id: `m${seq + 1}`, tool: toolRef.current, color: myColor, pts: [], last: 0, ended: false };
      strokes.current.set(cur.id, cur);
      add(e);
    };
    const move = (e: PointerEvent) => {
      if (!cur) return;
      // The browser batches fast moves; take every sample for a smooth line.
      const all = e.getCoalescedEvents?.() ?? [];
      for (const ce of all.length ? all : [e]) add(ce);
    };
    const up = (e: PointerEvent) => {
      if (!cur) return;
      add(e, true);
      cur.ended = true;
      cur = null;
    };
    const wheel = (e: WheelEvent) => {
      // Let the code scroll underneath while drawing.
      const ed = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el !== cv);
      ed?.dispatchEvent(new WheelEvent("wheel", e));
    };
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("wheel", wheel, { passive: true });
    return () => {
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("wheel", wheel);
    };
  }, [session, myColor]);

  // ---- render loop ----
  useEffect(() => {
    const cv = canvasRef.current!;
    const ctx = cv.getContext("2d")!;
    const laserCanvas = document.createElement("canvas");
    let raf = 0;
    let cur: { x: number; y: number } | null = null;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const dpr = devicePixelRatio || 1;
      if (cv.width !== innerWidth * dpr || cv.height !== innerHeight * dpr) {
        cv.width = innerWidth * dpr;
        cv.height = innerHeight * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      const now = performance.now();

      for (const s of strokes.current.values()) {
        if (s.tool === "laser" && s.ended && now - s.last > LASER_FADE_MS) {
          strokes.current.delete(s.id);
          continue;
        }
        drawStroke(ctx, s, now, laserCanvas);
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;

      // Remote pointer: ease toward the target every frame (Figma-style smooth motion).
      const el = pointerRef.current!;
      const a = remoteAnchor.current;
      const pt = a ? pointerTarget(a) : null;
      const target = pt;
      const hintEl = hintRef.current;
      if (hintEl && pt && hintEl.textContent !== pt.hint) {
        hintEl.textContent = pt.hint;
        el.classList.toggle("docked", !!pt.hint);
      }
      if (target) {
        if (!cur || Math.hypot(target.x - cur.x, target.y - cur.y) > 600) cur = { ...target };
        else {
          cur.x += (target.x - cur.x) * 0.35;
          cur.y += (target.y - cur.y) * 0.35;
        }
        el.style.transform = `translate3d(${cur.x}px, ${cur.y}px, 0)`;
        el.style.opacity = "1";
      } else {
        el.style.opacity = "0";
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <>
      <canvas ref={canvasRef} className={`overlay${tool ? " drawing" : ""}`} style={{ width: "100vw", height: "100vh" }} />
      <div ref={pointerRef} className="remote-pointer" style={{ opacity: 0 }}>
        <svg width="24" height="24" viewBox="0 0 24 24" className="cursor-svg">
          <path
            d="M4.2 3.1 L19.6 9.4 C20.5 9.8 20.4 11.1 19.5 11.4 L13.3 13.3 L11.4 19.5 C11.1 20.4 9.8 20.5 9.4 19.6 L3.1 4.2 C2.8 3.5 3.5 2.8 4.2 3.1 Z"
            fill={peerColor}
            stroke="#fff"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
        <div className="cursor-label" style={{ background: peerColor }}>
          {peerTool === "laser" && <Zap size={11} strokeWidth={2.5} />}
          {peerTool === "pen" && <PenLine size={11} strokeWidth={2.5} />}
          {peerTool === "highlighter" && <Highlighter size={11} strokeWidth={2.5} />}
          {peerName}
          <span ref={hintRef} className="cursor-hint" />
        </div>
      </div>
      {tool && (
        <div className="draw-hint">
          {tool === "laser" ? <Zap size={13} /> : tool === "pen" ? <PenLine size={13} /> : <Highlighter size={13} />}
          {tool === "laser" ? "Laser" : tool === "pen" ? "Pen" : "Highlighter"} — drag to draw
          <span className="kbd">Esc</span> stop
          <span className="kbd">Ctrl+Alt+C</span> clear
        </div>
      )}
    </>
  );
}
