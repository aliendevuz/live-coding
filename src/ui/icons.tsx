// File and folder icons: Material Icon Theme (PKief, MIT), resolved the way
// VS Code resolves an icon theme. scripts/gen-icon-map.mjs copies the SVGs to
// public/material-icons and writes the mapping imported here.

import map from "./material-icons.json";
import { monaco } from "./monaco-setup";

interface IconMap {
  file: string;
  folder: string;
  folderExpanded: string;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  languageIds: Record<string, string>;
  files: Record<string, string>;
}
const M = map as IconMap;

let extToLanguage: Map<string, string> | null = null;
function languageOfExt(ext: string): string | undefined {
  if (!extToLanguage) {
    extToLanguage = new Map();
    for (const l of monaco.languages.getLanguages()) for (const e of l.extensions ?? []) extToLanguage.set(e.replace(/^\./, "").toLowerCase(), l.id);
  }
  return extToLanguage.get(ext);
}

const url = (id: string) => `/material-icons/${M.files[id] ?? `${id}.svg`}`;

/** Icon id for a file name: exact name, then the longest extension, then its language. */
export function fileIconId(name: string): string {
  const lower = name.toLowerCase();
  if (M.fileNames[lower]) return M.fileNames[lower];
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    if (M.fileExtensions[ext]) return M.fileExtensions[ext];
  }
  const lang = parts.length > 1 ? languageOfExt(parts[parts.length - 1]) : undefined;
  if (lang && M.languageIds[lang]) return M.languageIds[lang];
  return M.file;
}

export function folderIconId(name: string, open: boolean): string {
  const lower = name.toLowerCase();
  const id = open ? M.folderNamesExpanded[lower] : M.folderNames[lower];
  return id ?? (open ? M.folderExpanded : M.folder);
}

export function FileIcon({ name, size = 16 }: { name: string; size?: number }) {
  return <img className="mi" src={url(fileIconId(name))} width={size} height={size} alt="" draggable={false} />;
}

export function FolderIcon({ name = "", open, size = 16 }: { name?: string; open: boolean; size?: number }) {
  return <img className="mi" src={url(folderIconId(name, open))} width={size} height={size} alt="" draggable={false} />;
}

/** The Duet mark: two voices (teacher and student) overlapping, and a Figma-style cursor. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="64 64 896 896" aria-hidden style={{ flex: "none" }}>
      <rect x="64" y="64" width="896" height="896" rx="228" fill="#16161A" />
      <circle cx="410" cy="470" r="230" fill="#7B61FF" />
      <circle cx="614" cy="470" r="230" fill="#0D99FF" style={{ mixBlendMode: "screen" }} />
      <path
        transform="translate(548 548) scale(13)"
        d="M4.2 3.1 L19.6 9.4 C20.5 9.8 20.4 11.1 19.5 11.4 L13.3 13.3 L11.4 19.5 C11.1 20.4 9.8 20.5 9.4 19.6 L3.1 4.2 C2.8 3.5 3.5 2.8 4.2 3.1 Z"
        fill="#FFA629"
        stroke="#fff"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
