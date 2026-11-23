// Monaco <-> Y.Text binding with remote cursors.
//
// Adapted from y-monaco 0.1.6 (MIT, Kevin Jahns). One behavioral change:
// cursor positions are stored "sticky to the left" (Yjs assoc = -1). In
// y-monaco a caret sticks to the character after it, so when the partner
// presses Enter exactly where my caret is, my caret (and how they see it)
// jumps to the next line. Here it stays put: text inserted at a caret goes
// after it. A selection keeps insertions at its edges outside of it.

import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { monaco } from "./monaco-setup";

/** Left edge of a range: sticks right (text typed at the edge stays outside). Caret / right edge: sticks left. */
const rel = (t: Y.Text, index: number, stickLeft: boolean) => Y.createRelativePositionFromTypeIndex(t, index, stickLeft ? -1 : 0);

interface RelSel {
  start: Y.RelativePosition;
  end: Y.RelativePosition;
  dir: monaco.SelectionDirection;
}

function saveSelection(ed: monaco.editor.ICodeEditor, model: monaco.editor.ITextModel, t: Y.Text): RelSel | null {
  const sel = ed.getSelection();
  if (!sel) return null;
  const s = model.getOffsetAt(sel.getStartPosition());
  const e = model.getOffsetAt(sel.getEndPosition());
  const caret = s === e;
  return { start: rel(t, s, caret), end: rel(t, e, true), dir: sel.getDirection() };
}

function restoreSelection(ed: monaco.editor.ICodeEditor, t: Y.Text, r: RelSel, doc: Y.Doc): monaco.Selection | null {
  const s = Y.createAbsolutePositionFromRelativePosition(r.start, doc);
  const e = Y.createAbsolutePositionFromRelativePosition(r.end, doc);
  if (!s || !e || s.type !== t || e.type !== t) return null;
  const model = ed.getModel()!;
  const a = model.getPositionAt(s.index);
  const b = model.getPositionAt(Math.max(s.index, e.index));
  return monaco.Selection.createWithDirection(a.lineNumber, a.column, b.lineNumber, b.column, r.dir);
}

export class MonacoBinding {
  private doc: Y.Doc;
  private busy = false;
  private saved = new Map<monaco.editor.ICodeEditor, RelSel>();
  private decorations = new Map<monaco.editor.ICodeEditor, string[]>();
  private disposers: (() => void)[] = [];

  constructor(
    private ytext: Y.Text,
    private model: monaco.editor.ITextModel,
    private editors: Set<monaco.editor.ICodeEditor>,
    private awareness: Awareness | null,
  ) {
    this.doc = ytext.doc!;

    const before = () =>
      this.guard(() => {
        this.saved = new Map();
        for (const ed of editors) {
          if (ed.getModel() !== model) continue;
          const r = saveSelection(ed, model, ytext);
          if (r) this.saved.set(ed, r);
        }
      });
    this.doc.on("beforeAllTransactions", before);
    this.disposers.push(() => this.doc.off("beforeAllTransactions", before));

    // Remote text changes -> Monaco, then put every local caret back where it was.
    const observer = (ev: Y.YTextEvent) => {
      this.guard(() => {
        let index = 0;
        for (const op of ev.delta) {
          if (op.retain !== undefined) index += op.retain;
          else if (op.insert !== undefined) {
            const p = model.getPositionAt(index);
            const text = op.insert as string;
            model.applyEdits([{ range: new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column), text }]);
            index += text.length;
          } else if (op.delete !== undefined) {
            const p = model.getPositionAt(index);
            const q = model.getPositionAt(index + op.delete);
            model.applyEdits([{ range: new monaco.Range(p.lineNumber, p.column, q.lineNumber, q.column), text: "" }]);
          }
        }
        for (const [ed, r] of this.saved) {
          const sel = restoreSelection(ed, ytext, r, this.doc);
          if (sel) ed.setSelection(sel);
        }
      });
      this.render();
    };
    ytext.observe(observer);
    this.disposers.push(() => ytext.unobserve(observer));

    if (model.getValue() !== ytext.toString()) model.setValue(ytext.toString());

    // Local Monaco edits -> Y.Text (right to left, so offsets stay valid).
    const onChange = model.onDidChangeContent((e) =>
      this.guard(() =>
        this.doc.transact(() => {
          [...e.changes]
            .sort((a, b) => b.rangeOffset - a.rangeOffset)
            .forEach((c) => {
              ytext.delete(c.rangeOffset, c.rangeLength);
              ytext.insert(c.rangeOffset, c.text);
            });
        }, this),
      ),
    );
    const onDispose = model.onWillDispose(() => this.destroy());
    this.disposers.push(() => onChange.dispose(), () => onDispose.dispose());

    if (awareness) {
      for (const ed of editors) {
        const sub = ed.onDidChangeCursorSelection(() => this.publish(ed));
        this.disposers.push(() => sub.dispose());
      }
      const render = () => this.render();
      awareness.on("change", render);
      this.disposers.push(() => awareness.off("change", render));
    }
  }

  /** Like lib0's mutex: changes we cause ourselves must not echo back. */
  private guard(fn: () => void) {
    if (this.busy) return;
    this.busy = true;
    try {
      fn();
    } finally {
      this.busy = false;
    }
  }

  private publish(ed: monaco.editor.ICodeEditor) {
    if (!this.awareness || ed.getModel() !== this.model) return;
    const sel = ed.getSelection();
    if (!sel) return;
    let anchor = this.model.getOffsetAt(sel.getStartPosition());
    let head = this.model.getOffsetAt(sel.getEndPosition());
    const caret = anchor === head;
    let anchorLeft = caret;
    let headLeft = true;
    if (sel.getDirection() === monaco.SelectionDirection.RTL) {
      [anchor, head] = [head, anchor];
      [anchorLeft, headLeft] = [true, caret];
    }
    this.awareness.setLocalStateField("selection", {
      anchor: rel(this.ytext, anchor, anchorLeft),
      head: rel(this.ytext, head, headLeft),
    });
  }

  private render() {
    const aw = this.awareness;
    for (const ed of this.editors) {
      const old = this.decorations.get(ed) ?? [];
      if (!aw || ed.getModel() !== this.model) {
        this.decorations.delete(ed);
        continue;
      }
      const next: monaco.editor.IModelDeltaDecoration[] = [];
      aw.getStates().forEach((st, id) => {
        const s = st.selection;
        if (id === this.doc.clientID || !s?.anchor || !s?.head) return;
        const a = Y.createAbsolutePositionFromRelativePosition(s.anchor, this.doc);
        const h = Y.createAbsolutePositionFromRelativePosition(s.head, this.doc);
        if (!a || !h || a.type !== this.ytext || h.type !== this.ytext) return;
        const forward = a.index < h.index;
        const p = this.model.getPositionAt(Math.min(a.index, h.index));
        const q = this.model.getPositionAt(Math.max(a.index, h.index));
        const head = `yRemoteSelectionHead yRemoteSelectionHead-${id}`;
        next.push({
          range: new monaco.Range(p.lineNumber, p.column, q.lineNumber, q.column),
          options: {
            className: `yRemoteSelection yRemoteSelection-${id}`,
            afterContentClassName: forward ? head : null,
            beforeContentClassName: forward ? null : head,
          },
        });
      });
      this.decorations.set(ed, ed.deltaDecorations(old, next));
    }
  }

  destroy() {
    this.disposers.splice(0).forEach((d) => d());
  }
}
