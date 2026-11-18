import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

// No IntelliSense in this version: keep syntax errors, drop semantic checks
// (they would complain about every import a single file can't resolve).
for (const d of [monaco.typescript.javascriptDefaults, monaco.typescript.typescriptDefaults]) {
  d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
}

monaco.editor.defineTheme("duet", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#1a1a1d",
    "editorGutter.background": "#1a1a1d",
    "editor.lineHighlightBackground": "#ffffff08",
    "editor.lineHighlightBorder": "#00000000",
    "editorLineNumber.foreground": "#4a4a52",
    "editorLineNumber.activeForeground": "#b4b4bc",
    "editor.selectionBackground": "#0d99ff44",
    "editor.inactiveSelectionBackground": "#0d99ff22",
    "editorCursor.foreground": "#0d99ff",
    "editorIndentGuide.background1": "#ffffff0d",
    "editorIndentGuide.activeBackground1": "#ffffff26",
    "editorWidget.background": "#222226",
    "editorWidget.border": "#36363d",
    "minimap.background": "#1a1a1d",
    "scrollbarSlider.background": "#ffffff18",
    "scrollbarSlider.hoverBackground": "#ffffff2a",
    "scrollbarSlider.activeBackground": "#ffffff38",
  },
});

export { monaco };
