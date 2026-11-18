import {
  File,
  FileCode,
  FileImage,
  FileJson,
  FileTerminal,
  FileText,
  Folder,
  FolderOpen,
  Lock,
  type LucideIcon,
} from "lucide-react";

const CODE: Record<string, string> = {
  py: "#4B8BBE", js: "#E8C547", mjs: "#E8C547", cjs: "#E8C547", ts: "#3178C6", tsx: "#3178C6", jsx: "#61DAFB",
  html: "#E44D26", htm: "#E44D26", css: "#663399", scss: "#C6538C", less: "#1D365D", java: "#E76F00",
  c: "#A8B9CC", h: "#A8B9CC", cpp: "#F34B7D", cs: "#9B4F96", go: "#00ADD8", rs: "#DEA584", php: "#8892BF",
  rb: "#CC342D", sql: "#E38C00", vue: "#41B883", svelte: "#FF3E00", kt: "#A97BFF", swift: "#F05138",
  dart: "#0175C2", lua: "#6C78FC", r: "#276DC3", xml: "#E37933", yaml: "#CB171E", yml: "#CB171E", toml: "#9C4221",
};
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg", "avif"]);
const TEXT = new Set(["md", "txt", "rst", "log", "csv"]);
const SHELL = new Set(["ps1", "bat", "cmd", "sh"]);

export function fileIcon(name: string): { Icon: LucideIcon; color: string } {
  const lower = name.toLowerCase();
  const ext = lower.split(".").pop() ?? "";
  if (lower === ".env" || lower.startsWith(".env.")) return { Icon: Lock, color: "#E5C07B" };
  if (ext === "json") return { Icon: FileJson, color: "#CBCB41" };
  if (IMAGE.has(ext)) return { Icon: FileImage, color: "#A074C4" };
  if (SHELL.has(ext)) return { Icon: FileTerminal, color: "#4EC9B0" };
  if (TEXT.has(ext)) return { Icon: FileText, color: "#8AA4B8" };
  if (ext in CODE) return { Icon: FileCode, color: CODE[ext] };
  return { Icon: File, color: "#8B949E" };
}

export function FileIcon({ name, size = 15 }: { name: string; size?: number }) {
  const { Icon, color } = fileIcon(name);
  return <Icon size={size} color={color} strokeWidth={1.75} style={{ flex: "none" }} />;
}

export function FolderIcon({ open, size = 15 }: { open: boolean; size?: number }) {
  const Icon = open ? FolderOpen : Folder;
  return <Icon size={size} color="#C09553" strokeWidth={1.75} style={{ flex: "none" }} />;
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
