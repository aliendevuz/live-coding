// Quick open (Ctrl+P) and command palette (Ctrl+Shift+P), VS Code style.
// Typing ">" in quick open switches to commands, deleting it switches back.

import { useEffect, useMemo, useRef, useState } from "react";
import { Command as CommandIcon } from "lucide-react";
import { basename, dirname } from "../core/util";
import { FileIcon } from "./icons";

export interface Command {
  id: string;
  title: string;
  keys?: string;
  run: () => void;
}

interface Props {
  mode: "files" | "commands";
  commands: Command[];
  loadFiles: () => Promise<string[]>;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}

/** Subsequence match; lower is better, null = no match. Rewards contiguous runs and basename hits. */
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let last = -1;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    score += i - ti + (last >= 0 && i !== last + 1 ? 2 : 0);
    last = i;
    ti = i + 1;
  }
  const base = t.lastIndexOf("/") + 1;
  if (t.indexOf(q, base) >= 0) score -= 20; // the query is in the file name itself
  return score + t.length * 0.01;
}

export function Palette({ mode, commands, loadFiles, onOpenFile, onClose }: Props) {
  const [query, setQuery] = useState(mode === "commands" ? ">" : "");
  const [files, setFiles] = useState<string[] | null>(null);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const isCommands = query.startsWith(">");
  const q = (isCommands ? query.slice(1) : query).trim();

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    if (!isCommands && files === null) void loadFiles().then(setFiles, () => setFiles([]));
  }, [isCommands, files, loadFiles]);

  const items = useMemo(() => {
    if (isCommands) {
      return commands
        .map((c) => ({ c, s: fuzzyScore(q, c.title) }))
        .filter((x) => x.s !== null)
        .sort((a, b) => a.s! - b.s!)
        .map((x) => ({ key: x.c.id, label: x.c.title, hint: x.c.keys ?? "", run: x.c.run, file: null as string | null }));
    }
    return (files ?? [])
      .map((f) => ({ f, s: fuzzyScore(q, f) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => a.s! - b.s!)
      .slice(0, 80)
      .map((x) => ({ key: x.f, label: basename(x.f), hint: dirname(x.f), run: () => onOpenFile(x.f), file: x.f }));
  }, [isCommands, commands, files, q, onOpenFile]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const choose = (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    it.run();
  };

  return (
    <div className="palette-back" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder={isCommands ? "Type a command" : "Search files by name (type > for commands)"}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setIndex((i) => Math.min(items.length - 1, i + 1));
            else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
            else if (e.key === "Enter") choose(index);
            else if (e.key === "Escape") onClose();
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
        <div className="palette-list" ref={listRef}>
          {!isCommands && files === null && <div className="palette-empty">Loading files…</div>}
          {items.length === 0 && (isCommands || files !== null) && <div className="palette-empty">No matches</div>}
          {items.map((it, i) => (
            <div
              key={it.key}
              className={`palette-item${i === index ? " active" : ""}`}
              onMouseMove={() => setIndex(i)}
              onClick={() => choose(i)}
            >
              {it.file ? <FileIcon name={it.file} /> : <CommandIcon size={14} className="dim" />}
              <span className="palette-label">{it.label}</span>
              <span className="palette-hint">{it.hint}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
