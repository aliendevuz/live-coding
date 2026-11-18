// Workbench layout (which panes are shown, their sizes, zoom), remembered
// between lessons like VS Code does.

import { useCallback, useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

export interface Layout {
  explorer: boolean;
  panel: boolean;
  chat: boolean;
  leftW: number;
  rightW: number;
  bottomH: number;
  zoom: number;
}

const KEY = "duet.layout";
const DEFAULTS: Layout = { explorer: true, panel: true, chat: true, leftW: 250, rightW: 290, bottomH: 260, zoom: 1 };

export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

function load(): Layout {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Layout>) };
  } catch {
    return DEFAULTS;
  }
}

export function applyZoom(z: number) {
  void getCurrentWebview()
    .setZoom(z)
    .catch(() => {
      // Fallback outside Tauri (tests in a browser).
      (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = String(z);
    });
}

export function useLayout() {
  const [layout, setLayout] = useState<Layout>(load);
  useEffect(() => localStorage.setItem(KEY, JSON.stringify(layout)), [layout]);
  useEffect(() => applyZoom(layout.zoom), [layout.zoom]);
  const update = useCallback((patch: Partial<Layout> | ((l: Layout) => Partial<Layout>)) => {
    setLayout((l) => ({ ...l, ...(typeof patch === "function" ? patch(l) : patch) }));
  }, []);
  return [layout, update] as const;
}

/** Next zoom step up (+1) or down (-1). */
export function stepZoom(z: number, dir: 1 | -1) {
  const i = ZOOM_STEPS.findIndex((s) => Math.abs(s - z) < 0.01);
  const cur = i >= 0 ? i : ZOOM_STEPS.indexOf(1);
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, cur + dir))];
}
