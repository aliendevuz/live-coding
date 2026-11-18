// Monaco providers backed by the session's language servers (core/lsp.ts).
// Registered once for the app's lifetime; each call asks whichever session
// is active, so leaving and joining lessons never stacks providers.

import { activeLsp, type Diagnostic, type Lsp, type LspStatus, type ServerKey } from "../core/lsp";
import { editorRegistry } from "./editor-registry";
import { monaco } from "./monaco-setup";

type M = typeof monaco;
type Model = monaco.editor.ITextModel;
const L = monaco.languages;

/* eslint-disable @typescript-eslint/no-explicit-any */

const pathOf = (model: Model) => (model.uri.scheme === "file" ? model.uri.path.replace(/^\//, "") : null);
const pos = (p: monaco.Position) => ({ line: p.lineNumber - 1, character: p.column - 1 });
const range = (r: any): monaco.IRange => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1,
});

function ask<T>(server: ServerKey, model: Model, method: string, params: Record<string, unknown>): Promise<T | null> {
  const lsp = activeLsp;
  const path = pathOf(model);
  if (!lsp || !path || !lsp.isReady(server)) return Promise.resolve(null);
  return lsp
    .request<T>(path, model.getValueLength(), method, { textDocument: { uri: "" }, ...params })
    .catch(() => null);
}

function markdown(v: any): monaco.IMarkdownString | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return { value: v };
  if (v.kind === "markdown") return { value: v.value, supportThemeIcons: false };
  if (v.kind === "plaintext") return { value: v.value.replace(/[\\`*_{}[\]()#+\-.!<>]/g, "\\$&") };
  if (v.language) return { value: "```" + v.language + "\n" + v.value + "\n```" };
  return undefined;
}

const K = L.CompletionItemKind;
// LSP CompletionItemKind (1-based) -> Monaco
const KIND = [K.Text, K.Text, K.Method, K.Function, K.Constructor, K.Field, K.Variable, K.Class, K.Interface, K.Module,
  K.Property, K.Unit, K.Value, K.Enum, K.Keyword, K.Snippet, K.Color, K.File, K.Reference, K.Folder, K.EnumMember,
  K.Constant, K.Struct, K.Event, K.Operator, K.TypeParameter];

/** Original LSP item for each suggestion, for completionItem/resolve. */
const origin = new WeakMap<monaco.languages.CompletionItem, { item: any; model: Model; server: ServerKey }>();

function textEdits(edits: any[] | undefined): monaco.languages.TextEdit[] | undefined {
  return edits?.map((e) => ({ range: range(e.range), text: e.newText }));
}

function toSuggestion(it: any, model: Model, server: ServerKey, wordRange: monaco.IRange): monaco.languages.CompletionItem {
  const edit = it.textEdit;
  const text = edit?.newText ?? it.insertText ?? it.label;
  const r = edit ? range(edit.range ?? edit.insert) : wordRange;
  const s: monaco.languages.CompletionItem = {
    label: it.labelDetails ? { label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description } : it.label,
    kind: KIND[it.kind ?? 1] ?? K.Text,
    detail: it.detail,
    documentation: markdown(it.documentation),
    insertText: text,
    insertTextRules: it.insertTextFormat === 2 ? L.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    range: r,
    sortText: it.sortText,
    filterText: it.filterText,
    preselect: it.preselect,
    commitCharacters: it.commitCharacters,
    additionalTextEdits: textEdits(it.additionalTextEdits),
    tags: it.deprecated || it.tags?.includes(1) ? [L.CompletionItemTag.Deprecated] : undefined,
  };
  origin.set(s, { item: it, model, server });
  return s;
}

function registerFor(server: ServerKey, languages: string[], triggers: string[]) {
  for (const lang of languages) {
    L.registerCompletionItemProvider(lang, {
      triggerCharacters: triggers,
      async provideCompletionItems(model, position, ctx) {
        const res = await ask<any>(server, model, "textDocument/completion", {
          position: pos(position),
          context: { triggerKind: ctx.triggerKind + 1, triggerCharacter: ctx.triggerCharacter },
        });
        if (!res) return null;
        const items: any[] = Array.isArray(res) ? res : res.items ?? [];
        const w = model.getWordUntilPosition(position);
        const wordRange = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn };
        return {
          suggestions: items.slice(0, 2000).map((it) => toSuggestion(it, model, server, wordRange)),
          incomplete: !Array.isArray(res) && !!res.isIncomplete,
        };
      },
      async resolveCompletionItem(item) {
        const o = origin.get(item);
        if (!o || (item.documentation && item.detail)) return item;
        const r = await ask<any>(o.server, o.model, "completionItem/resolve", o.item);
        if (!r) return item;
        item.detail ??= r.detail;
        item.documentation ??= markdown(r.documentation);
        if (r.additionalTextEdits && !item.additionalTextEdits) item.additionalTextEdits = textEdits(r.additionalTextEdits);
        return item;
      },
    });

    L.registerHoverProvider(lang, {
      async provideHover(model, position) {
        const r = await ask<any>(server, model, "textDocument/hover", { position: pos(position) });
        if (!r?.contents) return null;
        const c = Array.isArray(r.contents) ? r.contents : [r.contents];
        const contents = c.map(markdown).filter(Boolean) as monaco.IMarkdownString[];
        return contents.length ? { contents, range: r.range ? range(r.range) : undefined } : null;
      },
    });

    L.registerSignatureHelpProvider(lang, {
      signatureHelpTriggerCharacters: ["(", ","],
      signatureHelpRetriggerCharacters: [")"],
      async provideSignatureHelp(model, position, _token, ctx) {
        const r = await ask<any>(server, model, "textDocument/signatureHelp", {
          position: pos(position),
          context: { triggerKind: ctx.triggerKind, triggerCharacter: ctx.triggerCharacter, isRetrigger: ctx.isRetrigger },
        });
        if (!r?.signatures?.length) return null;
        return {
          value: {
            signatures: r.signatures.map((sig: any) => ({
              label: sig.label,
              documentation: markdown(sig.documentation),
              parameters: (sig.parameters ?? []).map((p: any) => ({ label: p.label, documentation: markdown(p.documentation) })),
              activeParameter: sig.activeParameter,
            })),
            activeSignature: r.activeSignature ?? 0,
            activeParameter: r.activeParameter ?? 0,
          },
          dispose() {},
        };
      },
    });

    const locations = async (r: any): Promise<monaco.languages.Location[]> => {
      if (!r) return [];
      const list: any[] = Array.isArray(r) ? r : [r];
      const out: monaco.languages.Location[] = [];
      for (const l of list) {
        const uri = monaco.Uri.parse(l.targetUri ?? l.uri);
        // Only project files can be shown: make sure the target is loaded.
        if (!(await editorRegistry.ensureModel(uri.path.replace(/^\//, "")))) continue;
        out.push({ uri, range: range(l.targetSelectionRange ?? l.range) });
      }
      return out;
    };
    L.registerDefinitionProvider(lang, {
      async provideDefinition(model, position) {
        return locations(await ask(server, model, "textDocument/definition", { position: pos(position) }));
      },
    });
    L.registerReferenceProvider(lang, {
      async provideReferences(model, position, ctx) {
        return locations(await ask(server, model, "textDocument/references", { position: pos(position), context: ctx }));
      },
    });
    L.registerDocumentHighlightProvider(lang, {
      async provideDocumentHighlights(model, position) {
        const r = await ask<any[]>(server, model, "textDocument/documentHighlight", { position: pos(position) });
        return r?.map((h) => ({ range: range(h.range), kind: (h.kind ?? 1) - 1 })) ?? null;
      },
    });
  }
}

// ---- diagnostics -> markers ----

const OWNER = "duet-lsp";
const SEVERITY = [0, monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint];

function applyMarkers(path: string, diags: Diagnostic[]) {
  const model = monaco.editor.getModel(monaco.Uri.file("/" + path));
  if (!model) return;
  monaco.editor.setModelMarkers(
    model,
    OWNER,
    diags.map((d) => ({
      ...range(d.range),
      severity: SEVERITY[d.severity ?? 1] ?? monaco.MarkerSeverity.Error,
      message: d.message,
      source: d.source,
      code: d.code != null ? String(d.code) : undefined,
      tags: d.tags?.map((t) => (t === 1 ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated)),
    })),
  );
}

// ---- built-in JS/TS service: only while the real server is not available ----

function builtinTs(m: M, on: boolean) {
  const modes = {
    completionItems: on,
    hovers: on,
    signatureHelp: on,
    definitions: on,
    references: on,
    documentHighlights: on,
    rename: on,
    diagnostics: on,
    documentSymbols: true,
    documentRangeFormattingEdits: true,
    onTypeFormattingEdits: true,
    codeActions: on,
    inlayHints: false,
  };
  m.typescript.javascriptDefaults.setModeConfiguration(modes);
  m.typescript.typescriptDefaults.setModeConfiguration(modes);
}

let bound: Lsp | null = null;
let offs: (() => void)[] = [];

/** Follow the active session's LSP status and diagnostics. Call when a session starts. */
export function attachLsp(lsp: Lsp) {
  offs.forEach((f) => f());
  bound = lsp;
  const onStatus = (st: LspStatus) => builtinTs(monaco, st.ts.state !== "ready");
  onStatus(lsp.status);
  for (const [path, d] of lsp.diagnostics) applyMarkers(path, d);
  offs = [
    lsp.on("status", onStatus),
    lsp.on("diagnostics", ({ path, diagnostics }) => applyMarkers(path, diagnostics)),
  ];
}

export function detachLsp(lsp: Lsp) {
  if (bound !== lsp) return;
  offs.forEach((f) => f());
  offs = [];
  bound = null;
  builtinTs(monaco, true);
  for (const model of monaco.editor.getModels()) monaco.editor.setModelMarkers(model, OWNER, []);
}

// Markers for files opened after their diagnostics arrived.
monaco.editor.onDidCreateModel((model) => {
  const path = pathOf(model);
  const d = path && bound?.diagnostics.get(path);
  if (path && d) setTimeout(() => applyMarkers(path, d), 0);
});

registerFor("python", ["python"], [".", "[", '"', "'"]);
registerFor("ts", ["javascript", "typescript"], [".", '"', "'", "`", "/", "@", "<", "#"]);
