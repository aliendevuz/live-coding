// Shared handle on the main code editor, so the pointer overlay can express
// positions as (file, line, column) and land on the same code on the peer's
// screen whatever its window size, font zoom or scroll position.

import { monaco } from "./monaco-setup";

export const editorRegistry: {
  editor: monaco.editor.IStandaloneCodeEditor | null;
  file: string | null;
  /** Load a project file's model without opening a tab (go-to-definition targets). */
  ensureModel: (path: string) => Promise<boolean>;
} = { editor: null, file: null, ensureModel: async () => false };

function metrics(ed: monaco.editor.IStandaloneCodeEditor) {
  const dom = ed.getDomNode()!;
  const rect = dom.getBoundingClientRect();
  const lh = ed.getOption(monaco.editor.EditorOption.lineHeight);
  const cw = ed.getOption(monaco.editor.EditorOption.fontInfo).typicalHalfwidthCharacterWidth;
  const contentLeft = ed.getLayoutInfo().contentLeft;
  return { rect, lh, cw, contentLeft };
}

/** Line (1-based, fractional) at a vertical offset inside the editor's scroll space. */
function lineAt(ed: monaco.editor.IStandaloneCodeEditor, scrollY: number, lh: number): number {
  const model = ed.getModel();
  if (!model) return 1;
  for (const r of ed.getVisibleRanges()) {
    for (let l = r.startLineNumber; l <= r.endLineNumber; l++) {
      const top = ed.getTopForLineNumber(l);
      if (scrollY >= top && scrollY < top + lh) return l + (scrollY - top) / lh;
    }
  }
  // Below the last line, or between ranges (folded): straight arithmetic.
  return scrollY / lh + 1;
}

/** Screen point -> code position, or null when not over the code editor. */
export function pointToCode(x: number, y: number): { file: string; line: number; col: number } | null {
  const ed = editorRegistry.editor;
  const file = editorRegistry.file;
  if (!ed || !file) return null;
  const { rect, lh, cw, contentLeft } = metrics(ed);
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
  const line = lineAt(ed, y - rect.top + ed.getScrollTop(), lh);
  const col = (x - rect.left - contentLeft + ed.getScrollLeft()) / cw;
  return { file, line, col };
}

/** Code position -> screen point, or null if that file is not shown / scrolled away. */
export function codeToPoint(a: { file: string; line: number; col: number }): { x: number; y: number } | null {
  const ed = editorRegistry.editor;
  if (!ed || editorRegistry.file !== a.file) return null;
  const { rect, lh, cw, contentLeft } = metrics(ed);
  const base = Math.floor(a.line);
  const lineCount = ed.getModel()?.getLineCount() ?? 1;
  const top = base <= lineCount ? ed.getTopForLineNumber(Math.max(1, base)) : (base - 1) * lh;
  const y = rect.top + top + (a.line - base) * lh - ed.getScrollTop();
  const x = rect.left + contentLeft + a.col * cw - ed.getScrollLeft();
  if (y < rect.top - 2 || y > rect.bottom + 2 || x > rect.right + 2) return null;
  return { x: Math.max(rect.left, x), y };
}

/** First visible line (fractional), used by follow mode. */
export function topLine(): number {
  const ed = editorRegistry.editor;
  if (!ed) return 1;
  return lineAt(ed, ed.getScrollTop(), ed.getOption(monaco.editor.EditorOption.lineHeight));
}

export function scrollToLine(line: number) {
  const ed = editorRegistry.editor;
  if (!ed) return;
  const base = Math.max(1, Math.floor(line));
  const lh = ed.getOption(monaco.editor.EditorOption.lineHeight);
  ed.setScrollTop(ed.getTopForLineNumber(base) + (line - base) * lh);
}
