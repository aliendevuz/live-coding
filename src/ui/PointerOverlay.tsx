// The partner's mouse pointer, plus laser / pen / highlighter drawing.
//
// Positions are sent as anchors, not pixels: over code they are (file, line,
// column), elsewhere a fraction of a named panel. So a stroke drawn under
// line 12 stays under line 12 on the other screen, and scrolls with the code.

import { useEffect, useRef, useState } from "react";
import { Highlighter, PenLine, Zap } from "lucide-react";
import type { Anchor, PointerMsg, Session } from "../core/session";
import { codeToPoint, pointToCode } from "./editor-registry";

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
    const move = (e: PointerEvent) => cur && add(e);
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
        const tool = s.tool;
        if (tool === "laser" && s.ended && now - s.last > LASER_FADE_MS) {
          strokes.current.delete(s.id);
          continue;
        }
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        let prev: { x: number; y: number } | null = null;
        for (const p of s.pts) {
          if (!p) continue; // lost on the unreliable channel: just bridge the gap
          const q = fromAnchor(p.a);
          if (!q) {
            prev = null;
            continue;
          }
          if (prev) {
            if (tool === "laser") {
              const age = now - p.t;
              const alpha = Math.max(0, 1 - age / LASER_FADE_MS);
              if (alpha <= 0) {
                prev = q;
                continue;
              }
              ctx.strokeStyle = `rgba(255, 60, 60, ${alpha})`;
              ctx.shadowColor = "rgba(255,0,0,0.8)";
              ctx.shadowBlur = 8;
              ctx.lineWidth = 4;
            } else if (tool === "highlighter") {
              ctx.shadowBlur = 0;
              ctx.strokeStyle = "rgba(255, 230, 0, 0.28)";
              ctx.lineWidth = 18;
              ctx.lineCap = "butt";
            } else {
              ctx.shadowBlur = 0;
              ctx.strokeStyle = s.color;
              ctx.lineWidth = 3;
            }
            ctx.beginPath();
            ctx.moveTo(prev.x, prev.y);
            ctx.lineTo(q.x, q.y);
            ctx.stroke();
          }
          prev = q;
        }
      }
      ctx.shadowBlur = 0;

      // Remote pointer: ease toward the target every frame (Figma-style smooth motion).
      const el = pointerRef.current!;
      const a = remoteAnchor.current;
      const target = a ? fromAnchor(a) : null;
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
