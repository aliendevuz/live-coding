// Files and folders dragged in from Windows Explorer. Tauri reports real
// paths (HTML5 drop events would not), in physical pixels.

import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export interface FileDrag {
  x: number; // CSS pixels
  y: number;
}

export function useFileDrop(onDrop: (paths: string[], x: number, y: number) => void, enabled = true) {
  const [drag, setDrag] = useState<FileDrag | null>(null);
  const cb = useRef(onDrop);
  cb.current = onDrop;
  useEffect(() => {
    if (!enabled) return;
    let un: (() => void) | null = null;
    let dead = false;
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        const dpr = window.devicePixelRatio || 1;
        if (p.type === "enter" || p.type === "over") setDrag({ x: p.position.x / dpr, y: p.position.y / dpr });
        else if (p.type === "leave") setDrag(null);
        else if (p.type === "drop") {
          setDrag(null);
          if (p.paths.length) cb.current(p.paths, p.position.x / dpr, p.position.y / dpr);
        }
      })
      .then((f) => (dead ? f() : (un = f)));
    return () => {
      dead = true;
      un?.();
    };
  }, [enabled]);
  return drag;
}
