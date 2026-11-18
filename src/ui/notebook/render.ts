// Rendering helpers for notebook cells and outputs.

import DOMPurify from "dompurify";
import { Marked } from "marked";
import markedKatex from "marked-katex-extension";
import "katex/dist/katex.min.css";

const md = new Marked({ gfm: true, breaks: false });
md.use(markedKatex({ throwOnError: false, nonStandard: true }));

/** Markdown (with $math$) to sanitized HTML. */
export function markdownToHtml(src: string): string {
  return DOMPurify.sanitize(md.parse(src) as string, { ADD_ATTR: ["target"] });
}

/** Untrusted HTML from a kernel (e.g. a pandas table): no scripts, no handlers. */
export function safeHtml(html: string): string {
  return DOMPurify.sanitize(html, { FORBID_TAGS: ["style"], FORBID_ATTR: ["style"] });
}

export function safeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Apply carriage returns like a terminal: "50%\r100%" shows "100%". */
export function applyCarriageReturns(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const i = line.lastIndexOf("\r");
      return i >= 0 && i < line.length - 1 ? line.slice(i + 1) : line.replace(/\r$/, "");
    })
    .join("\n");
}

const FG = ["#3b3b3b", "#ff6b5a", "#3ccf7e", "#ffc152", "#3aaaff", "#a18cff", "#4fd6e6", "#d8d8dc"];
const FG_BRIGHT = ["#67676f", "#ff8a70", "#5ee39a", "#ffd27a", "#6cc0ff", "#bfb0ff", "#7fe6f2", "#ffffff"];

/** ANSI SGR colors (IPython tracebacks) to HTML spans. Everything else is escaped. */
export function ansiToHtml(input: string): string {
  let out = "";
  let fg: string | null = null;
  let bg: string | null = null;
  let bold = false;
  let open = false;
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  const flush = (text: string) => {
    if (!text) return;
    if (fg || bg || bold) {
      out += `<span style="${fg ? `color:${fg};` : ""}${bg ? `background:${bg};` : ""}${bold ? "font-weight:600;" : ""}">${esc(text)}</span>`;
    } else out += esc(text);
  };
  for (let m; (m = re.exec(input)); ) {
    flush(input.slice(last, m.index));
    last = re.lastIndex;
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) [fg, bg, bold] = [null, null, false];
      else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c >= 30 && c <= 37) fg = FG[c - 30];
      else if (c >= 90 && c <= 97) fg = FG_BRIGHT[c - 90];
      else if (c === 39) fg = null;
      else if (c >= 40 && c <= 47) bg = FG[c - 40];
      else if (c === 49) bg = null;
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) i += 2; // 256 colors: keep default
      else if ((c === 38 || c === 48) && codes[i + 1] === 2) i += 4; // true color: keep default
    }
  }
  flush(input.slice(last).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""));
  void open;
  return out;
}

/** nbformat stores multi-line strings either as a string or a list of lines. */
export const joinText = (v: unknown): string => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : JSON.stringify(v, null, 2));

/** Richest MIME type we can show, in Jupyter's order of preference. */
export const MIME_ORDER = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/svg+xml",
  "text/html",
  "text/markdown",
  "text/latex",
  "application/json",
  "text/plain",
];
