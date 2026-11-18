// Visibility preview: shade what the partner cannot see right now.
//
// The partner publishes (Yjs awareness) which panes are open, the file they
// have open and the line / column range on their screen, and for notebooks
// the cells on their screen. Here those become shaded, labelled regions on
// top of our own screen, so whoever explains knows what the other person sees.

import { useEffect, useRef } from "react";
import type { Session } from "../core/session";
import type { CodeView } from "./editor-registry";
import { codeToPointRaw, editorRegistry } from "./editor-registry";

interface PeerState {
  file?: string | null;
  view?: CodeView | null;
  layout?: { explorer: boolean; panel: boolean; chat: boolean };
  nbView?: { path: string; cells: string[] } | null;
}

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

function peerState(session: Session): PeerState | null {
  for (const [id, st] of session.awareness.getStates()) if (id !== session.doc.clientID) return st as PeerState;
  return null;
}

const rectOf = (sel: string) => {
  const el = document.querySelector(sel) as HTMLElement | null;
  if (!el || !el.offsetParent) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
};

const shortName = (p: string) => p.split("/").pop() ?? p;

function regions(session: Session, name: string): Region[] {
  const peer = peerState(session);
  if (!peer) return [];
  const out: Region[] = [];
  const whole = (r: DOMRect | null, label: string) => r && out.push({ x: r.left, y: r.top, w: r.width, h: r.height, label });

  // Panes the partner has closed.
  const lay = peer.layout;
  if (lay) {
    if (!lay.explorer) whole(rectOf('[data-anchor="explorer"]'), `Explorer is hidden for ${name}`);
    if (!lay.panel) whole(rectOf('[data-anchor="panel"]'), `Terminal panel is hidden for ${name}`);
    if (!lay.chat) whole(rectOf('[data-anchor="chat"]'), `Chat is hidden for ${name}`);
  }

  const editor = rectOf(".editor-wrap");
  if (!editor) return out;
  const myFile = editorRegistry.file;
  const nb = document.querySelector(".nb-cells") as HTMLElement | null;

  // Notebook open here.
  if (nb && !myFile) {
    const box = nb.getBoundingClientRect();
    const nbv = peer.nbView;
    if (!nbv || peer.file !== nbv.path) {
      whole(editor, peer.file ? `${name} is in ${shortName(peer.file)}` : `${name} has no file open`);
      return out;
    }
    const seen = new Set(nbv.cells);
    nb.querySelectorAll<HTMLElement>("[data-cell]").forEach((el) => {
      if (seen.has(el.dataset.cell!)) return;
      const r = el.getBoundingClientRect();
      const top = Math.max(r.top, box.top);
      const bottom = Math.min(r.bottom, box.bottom);
      if (bottom - top > 2) out.push({ x: box.left, y: top, w: box.width, h: bottom - top, label: `Not on ${name}'s screen` });
    });
    return out;
  }

  if (!myFile) return out;
  const v = peer.view;
  if (!v || peer.file !== myFile || v.file !== myFile) {
    whole(editor, peer.file ? `${name} is in ${shortName(peer.file)}` : `${name} has no file open`);
    return out;
  }
  // Same file: shade lines above / below and columns beside the partner's view.
  const a = codeToPointRaw({ file: myFile, line: v.top, col: v.left });
  const b = codeToPointRaw({ file: myFile, line: v.bottom, col: v.right });
  if (!a || !b) return out;
  const box = a.box;
  const top = Math.max(box.top, Math.min(box.bottom, a.y));
  const bottom = Math.max(box.top, Math.min(box.bottom, b.y));
  if (top - box.top > 2) out.push({ x: editor.left, y: box.top, w: editor.width, h: top - box.top, label: `Above ${name}'s screen` });
  if (box.bottom - bottom > 2) out.push({ x: editor.left, y: bottom, w: editor.width, h: box.bottom - bottom, label: `Below ${name}'s screen` });
  const right = Math.max(box.left, b.x);
  if (box.right - right > 8 && bottom > top) out.push({ x: right, y: top, w: editor.right - right, h: bottom - top, label: `Off ${name}'s screen →` });
  const left = Math.min(box.right, a.x);
  if (left - box.left > 8 && bottom > top) out.push({ x: box.left, y: top, w: left - box.left, h: bottom - top, label: `← Off ${name}'s screen` });
  return out;
}

export function VisibilityOverlay({ session, enabled, peerName, peerColor }: { session: Session; enabled: boolean; peerName: string; peerColor: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!enabled) return;
    const cv = ref.current!;
    const ctx = cv.getContext("2d")!;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = devicePixelRatio || 1;
      if (cv.width !== innerWidth * dpr || cv.height !== innerHeight * dpr) {
        cv.width = innerWidth * dpr;
        cv.height = innerHeight * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const r of regions(session, peerName || "Partner")) {
        ctx.fillStyle = "rgba(8, 8, 12, 0.62)";
        ctx.fillRect(r.x, r.y, r.w, r.h);
        // Diagonal hatching, so shade is never mistaken for a dark theme.
        ctx.save();
        ctx.beginPath();
        ctx.rect(r.x, r.y, r.w, r.h);
        ctx.clip();
        ctx.strokeStyle = "rgba(255,255,255,0.05)";
        ctx.lineWidth = 1;
        for (let d = -r.h; d < r.w; d += 14) {
          ctx.beginPath();
          ctx.moveTo(r.x + d, r.y + r.h);
          ctx.lineTo(r.x + d + r.h, r.y);
          ctx.stroke();
        }
        ctx.restore();
        ctx.strokeStyle = peerColor;
        ctx.globalAlpha = 0.6;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        if (r.h >= 22 && r.w >= 80) {
          ctx.font = "600 11.5px Inter, Segoe UI, sans-serif";
          const tw = ctx.measureText(r.label).width;
          const lx = r.x + 8;
          const ly = r.y + (r.h > 40 ? 8 : (r.h - 20) / 2);
          ctx.fillStyle = peerColor;
          ctx.beginPath();
          ctx.roundRect(lx, ly, tw + 14, 20, 10);
          ctx.fill();
          ctx.fillStyle = "#fff";
          ctx.fillText(r.label, lx + 7, ly + 14);
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, cv.width, cv.height);
    };
  }, [enabled, session, peerName, peerColor]);

  return <canvas ref={ref} className="visibility-overlay" style={{ display: enabled ? "" : "none" }} />;
}
