// End-to-end test: two real Duet windows on this machine, host + guest,
// connected over WebRTC through the local signaling server. Driven via the
// WebView2 DevTools protocol.
//
//   npx tauri build --debug --no-bundle
//   node scripts/e2e.mjs [path-to-exe] [screenshot-dir]

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const EXE = process.argv[2] || path.join(ROOT, "src-tauri/target/debug/live.exe");
const SHOTS = process.argv[3] || os.tmpdir();
const CDP_PORT = 9339;
const SIG_PORT = 8799;
const WEB_PORT = 8765;

const procs = [];
const cleanup = () => procs.forEach((p) => p.kill());
process.on("exit", cleanup);

let failures = 0;
const ok = (cond, name, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  if (!cond) failures++;
};
const sha = (b) => createHash("sha256").update(b).digest("hex");

// ---------- fixture project ----------
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "duet-e2e-"));
const big = randomBytes(3 * 1024 * 1024 + 123);
fs.writeFileSync(path.join(proj, "main.py"), 'print("hello from main")\r\n');
fs.writeFileSync(path.join(proj, "index.html"), "<h1>Duet</h1>\n");
fs.writeFileSync(path.join(proj, "big.bin"), big);
fs.writeFileSync(path.join(proj, ".env"), "SECRET=1\n");
fs.writeFileSync(path.join(proj, ".gitignore"), "dist/\n*.log\n");
fs.writeFileSync(path.join(proj, "debug.log"), "x\n");
fs.mkdirSync(path.join(proj, "node_modules/pkg"), { recursive: true });
fs.writeFileSync(path.join(proj, "node_modules/pkg/index.js"), "module.exports = 1\n");
fs.writeFileSync(path.join(proj, "calc.py"), 'import os\n\n\ndef add(a: int, b: int) -> int:\n    """Add two numbers."""\n    return a + b\n');
fs.mkdirSync(path.join(proj, "src"));
fs.writeFileSync(path.join(proj, "src/app.js"), "console.log('app')\n");
const nbCell = (cell_type, source) =>
  cell_type === "code" ? { cell_type, id: Math.random().toString(16).slice(2, 10), metadata: {}, source, outputs: [], execution_count: null } : { cell_type, id: Math.random().toString(16).slice(2, 10), metadata: {}, source };
fs.writeFileSync(
  path.join(proj, "lesson.ipynb"),
  JSON.stringify(
    {
      cells: [nbCell("markdown", ["# Lesson 1\n", "Area: $A = \\pi r^2$"]), nbCell("code", ["x = 21\n", 'print("half", x)']), nbCell("code", "x * 2")],
      metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  ),
);
// Notebook tests need a Python with ipykernel (+ matplotlib, pandas): DUET_E2E_PYTHON_DIR.
const PY_DIR = process.env.DUET_E2E_PYTHON_DIR;

// ---------- processes ----------
procs.push(spawn(process.execPath, [path.join(ROOT, "signaling/dev-server.mjs")], { env: { ...process.env, PORT: String(SIG_PORT) }, stdio: "ignore" }));
procs.push(spawn("python", ["-m", "http.server", String(WEB_PORT), "--bind", "127.0.0.1", "--directory", proj], { stdio: "ignore" }));
const env = {
  // Own WebView2 profile: the installed Duet may be running with the default one.
  WEBVIEW2_USER_DATA_FOLDER: fs.mkdtempSync(path.join(os.tmpdir(), "duet-e2e-wv2-")),
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --use-fake-device-for-media-stream`,
};
if (PY_DIR) env.PATH = `${PY_DIR}${path.delimiter}${process.env.PATH}`;
procs.push(spawn(EXE, [], { env, stdio: "ignore" }));
await sleep(2500);
procs.push(spawn(EXE, [], { env, stdio: "ignore" }));

// ---------- CDP ----------
async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
      const pages = list.filter((t) => t.type === "page");
      if (pages.length >= 2) return pages;
    } catch {}
    await sleep(500);
  }
  throw new Error("app windows did not appear on the DevTools port");
}

class Page {
  constructor(t) {
    this.ws = new WebSocket(t.webSocketDebuggerUrl);
    this.id = 0;
    this.wait = new Map();
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const w = this.wait.get(m.id);
      if (w) {
        this.wait.delete(m.id);
        m.error ? w.rej(new Error(m.error.message)) : w.res(m.result);
      }
    };
    this.ready = new Promise((r) => (this.ws.onopen = r));
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.wait.set(id, { res, rej }));
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async until(expr, ms = 20000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (await this.eval(expr)) return true;
      } catch {}
      await sleep(200);
    }
    return false;
  }
  async shot(file) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
  }
  /** Center of the first element matching `sel`, in CSS pixels. */
  async center(sel) {
    return this.eval(`const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null`);
  }
  async mouse(type, x, y, extra = {}) {
    await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, ...extra });
  }
  /** A real pointer drag, in small steps so the app sees it as a drag. */
  async dragFromTo(a, b) {
    await this.mouse("mousePressed", a.x, a.y);
    for (let i = 1; i <= 12; i++) await this.mouse("mouseMoved", a.x + ((b.x - a.x) * i) / 12, a.y + ((b.y - a.y) * i) / 12);
    await sleep(150);
    await this.mouse("mouseReleased", b.x, b.y);
  }
  async key(key, code = key, keyCode = 0) {
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
  }
  /** A shortcut like Ctrl+Alt+B: mods from "ctrl", "alt", "shift". */
  async combo(mods, key, code, keyCode) {
    const m = (mods.includes("alt") ? 1 : 0) | (mods.includes("ctrl") ? 2 : 0) | (mods.includes("shift") ? 8 : 0);
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers: m });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers: m });
  }
}

const [t1, t2] = await targets();
const host = new Page(t1);
const guest = new Page(t2);
await Promise.all([host.ready, guest.ready]);
await host.until("return !!window.__duet");
await guest.until("return !!window.__duet");

const room = "e2e" + Math.random().toString(36).slice(2, 10);
const sig = process.env.SIGNALING_URL || `http://localhost:${SIG_PORT}`;
const S = "window.__duet.session";

await sleep(1200);
await host.shot(path.join(SHOTS, "duet-lobby.png"));
await host.eval(`await window.__duet.host({name:"Teacher", signalingUrl:"${sig}", micId:""}, ${JSON.stringify(proj)}, "${room}", "${"k".repeat(32)}")`);
await guest.eval(`await window.__duet.join({name:"Student", signalingUrl:"${sig}", micId:""}, "${room}")`);

const t0 = Date.now();
const connected = (await host.until(`return ${S}?.state === "connected" && !!${S}.peer`, 30000)) &&
  (await guest.until(`return ${S}?.state === "connected" && !!${S}.peer`, 30000));
ok(connected, "WebRTC connected via signaling", `${Date.now() - t0} ms`);
if (!connected) {
  await host.shot(path.join(SHOTS, "duet-host-fail.png"));
  process.exit(1);
}
ok((await guest.eval(`return ${S}.projectName`)) === path.basename(proj), "guest knows project name");
ok(await guest.eval(`return !!${S}.audio.track`), "guest microphone track (fake device)");

// ---- listing ----
const list = await guest.eval(`return await ${S}.files.list("")`);
const byName = Object.fromEntries(list.map((e) => [e.name, e]));
ok(byName["main.py"] && !byName["main.py"].ignored, "guest lists main.py");
ok(byName["node_modules"]?.ignored === true, "node_modules shown but ignored");
ok(byName[".env"]?.ignored === true, ".env shown but ignored");
ok(byName["debug.log"]?.ignored === true, ".gitignore respected");
const traversal = await guest.eval(`try { await ${S}.files.list("../"); return "no error" } catch (e) { return String(e) }`);
ok(traversal.includes("illegal path"), "path traversal rejected", traversal);

// ---- live text editing ----
ok((await guest.eval(`return (await ${S}.files.open("main.py")).kind`)) === "text", "guest opens main.py as text");
ok((await guest.eval(`return ${S}.files.map.get("main.py").toString()`)) === 'print("hello from main")\n', "CRLF normalized in the live document");
await guest.eval(`const t = ${S}.files.map.get("main.py"); t.insert(t.length, 'print("typed by guest")\\n')`);
let disk = "";
for (let i = 0; i < 30 && !disk.includes("typed by guest"); i++) {
  await sleep(200);
  disk = fs.readFileSync(path.join(proj, "main.py"), "utf8");
}
ok(disk === 'print("hello from main")\r\nprint("typed by guest")\r\n', "guest edit saved on host disk with CRLF kept", JSON.stringify(disk));
fs.writeFileSync(path.join(proj, "main.py"), 'print("edited on disk")\r\n');
ok(await guest.until(`return ${S}.files.map.get("main.py").toString() === 'print("edited on disk")\\n'`, 8000), "external disk change reaches the guest");

// ---- binary over bulk lane ----
const bin = await guest.eval(`
  const info = await ${S}.files.open("big.bin");
  const b = await ${S}.files.readBytes("big.bin", info);
  const h = await crypto.subtle.digest("SHA-256", b);
  return { kind: info.kind, len: b.length, hash: [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, "0")).join("") };`);
ok(bin.kind === "large" && bin.len === big.length && bin.hash === sha(big), "3 MB file streamed intact over the bulk lane", JSON.stringify({ kind: bin.kind, len: bin.len }));
const t1b = Date.now();
await guest.eval(`const info = await ${S}.files.open("big.bin"); await ${S}.files.readBytes("big.bin", info)`);
ok(Date.now() - t1b < 1500, "second read served from guest cache", `${Date.now() - t1b} ms`);

// ---- clone list ----
const clone = await guest.eval(`return (await ${S}.rpc.call("clone.list")).map(x => x.path).sort()`);
ok(!clone.includes(".env") && !clone.some((p) => p.startsWith("node_modules")) && !clone.includes("debug.log"), "clone skips .env, node_modules, gitignored", clone.join(","));
ok(clone.includes("src/app.js") && clone.includes("main.py"), "clone includes sources");

// ---- clone / download write path (dialogs bypassed) ----
const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), "duet-clone-")).split(path.sep).join("/");
await guest.eval(`
  const f = ${S}.files;
  for (const p of ["src/app.js", "big.bin"])
    await f["fetch"](p, null, { onData: (c, o) => f["localWrite"](${JSON.stringify(cloneDir)}, p, c, o) });`);
const clonedBig = fs.readFileSync(path.join(cloneDir, "big.bin"));
ok(sha(clonedBig) === sha(big) && fs.readFileSync(path.join(cloneDir, "src/app.js"), "utf8") === "console.log('app')\n", "cloned files written to the guest's folder intact");

// ---- terminal ----
const termId = await host.eval(`return await ${S}.terms.create()`);
ok(await guest.until(`return ${S}.terms.views.has(${termId})`, 8000), "guest sees the host terminal");
const bufText = (id) => `const v = ${S}.terms.views.get(${id}); const b = v.term.buffer.active; let s = ""; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + "\\n"; return s`;
await sleep(1500);
await host.eval(`${S}.terms.input(${termId}, "echo hello-duet-$((6*7))\\r")`);
ok(await guest.until(`const s = (() => { ${bufText(termId)} })(); return s.includes("hello-duet-42")`, 10000), "terminal output mirrored to guest");
await guest.eval(`${S}.terms.input(${termId}, "echo from-guest-denied\\r")`);
await sleep(1200);
ok(!(await host.eval(`const s = (() => { ${bufText(termId)} })(); return s.includes("from-guest-denied")`)), "guest typing blocked without permission");
await host.eval(`${S}.setPerms({ terminal: true })`);
ok(await guest.until(`return ${S}.perms.terminal === true`, 5000), "permission reaches guest");
await guest.eval(`${S}.terms.input(${termId}, "echo from-guest-$((2+3))\\r")`);
ok(await host.until(`const s = (() => { ${bufText(termId)} })(); return s.includes("from-guest-5")`, 8000), "guest typing runs on host once allowed");

// ---- tunnel ----
await host.eval(`${S}.tunnels.share(${WEB_PORT})`);
ok(await guest.until(`return ${S}.tunnels.ports.some(p => p.port === ${WEB_PORT} && p.local)`, 8000), "guest listens for the shared port");
const local = await guest.eval(`return ${S}.tunnels.ports.find(p => p.port === ${WEB_PORT}).local`);
ok(local !== WEB_PORT, "port busy locally, fell back to another", `local=${local}`);
const page = await (await fetch(`http://127.0.0.1:${local}/index.html`)).text();
ok(page === "<h1>Duet</h1>\n", "HTTP through the tunnel");
const tt = Date.now();
const tunneled = Buffer.from(await (await fetch(`http://127.0.0.1:${local}/big.bin`)).arrayBuffer());
ok(sha(tunneled) === sha(big), "3 MB download through the tunnel intact", `${Date.now() - tt} ms`);
const many = await Promise.all(Array.from({ length: 8 }, () => fetch(`http://127.0.0.1:${local}/index.html`).then((r) => r.text())));
ok(many.every((x) => x === "<h1>Duet</h1>\n"), "8 parallel tunneled requests");

// ---- chat / pointer ----
await guest.eval(`${S}.sendChat("salom ustoz")`);
ok(await host.until(`return ${S}.chat.some(m => m.text === "salom ustoz" && !m.mine)`, 5000), "chat message delivered");
await host.eval(`window.__gotPointer = false; ${S}.on("pointer", m => { if (m.t === "p") window.__gotPointer = true })`);
await guest.eval(`${S}.sendPointer({ t: "p", a: { k: "el", el: "editor", x: 0.5, y: 0.5 } })`);
ok(await host.until(`return window.__gotPointer`, 5000), "pointer position delivered");

// ---- audio ----
const audio = await guest.eval(`
  await new Promise(r => setTimeout(r, 1500));
  let bytes = 0; (await ${S}.link.pc.getStats()).forEach(s => { if (s.type === "inbound-rtp" && s.kind === "audio") bytes = s.bytesReceived });
  return bytes`);
ok(audio > 1000, "guest receives the host's audio stream", `${audio} bytes`);

// ---- follow + run + drawing ----
await host.eval(`document.querySelector('[data-path="main.py"]').click()`);
ok(await guest.until(`return document.querySelector(".tab.active")?.textContent.includes("main.py")`, 8000), "guest follows the host into main.py");
await host.eval(`document.querySelector(".tabs .tools button.primary").click()`);
ok(await guest.until(`return [...${S}.terms.views.values()].some(v => v.title.includes("main.py") && (() => { const b = v.term.buffer.active; let s = ""; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true); return s.includes("edited on disk") })())`, 15000), "Run executes main.py on the host, output visible to guest");
await host.eval(`for (let i = 0; i <= 20; i++) ${S}.sendPointer({ t: "s", id: 7, tool: "highlighter", i, a: { k: "code", file: "main.py", line: 1.5, col: i }, end: i === 20 })`);
await sleep(800);

// ---- IntelliSense (language servers on the host, asked by the guest) ----
ok((await guest.eval(`return (await ${S}.files.open("calc.py")).kind`)) === "text", "guest opens calc.py");
await guest.eval(`const t = ${S}.files.map.get("calc.py"); t.insert(t.length, "\\nx = add(1, 2)\\nimport nonexistent_mod_xyz\\nos.")`);
const pyText = await guest.eval(`return ${S}.files.map.get("calc.py").toString()`);
const lines = pyText.split("\n");
const lspT0 = Date.now();
ok(await host.until(`return ${S}.lsp.status.python.state === "ready"`, 240000), "Pyright installed and started on the host", `${Math.round((Date.now() - lspT0) / 1000)} s`);
ok(await guest.until(`return ${S}.lsp.status.python.state === "ready"`, 5000), "guest sees Python IntelliSense ready");
const req = (method, line, character, extra = "") =>
  guest.eval(`const t = ${S}.files.map.get("calc.py"); return await ${S}.lsp.request("calc.py", t.length, "${method}", { position: { line: ${line}, character: ${character} } ${extra} })`);
const comp = await req("textDocument/completion", lines.length - 1, 3);
const labels = (Array.isArray(comp) ? comp : comp?.items ?? []).map((i) => i.label);
ok(labels.includes("path") && labels.includes("getcwd"), "Python completion for os. (from the guest)", `${labels.length} items`);
const hover = await req("textDocument/hover", 3, 5);
ok(JSON.stringify(hover ?? "").includes("Add two numbers"), "hover shows the docstring");
const def = await req("textDocument/definition", lines.length - 3, 5);
const d0 = Array.isArray(def) ? def[0] : def;
ok(d0 && (d0.uri ?? d0.targetUri) === "file:///calc.py" && (d0.range ?? d0.targetSelectionRange).start.line === 3, "go to definition maps to the project file", JSON.stringify(d0?.uri ?? d0?.targetUri));
ok(await guest.until(`return (${S}.lsp.diagnostics.get("calc.py") ?? []).some(d => d.message.includes("nonexistent_mod_xyz"))`, 30000), "diagnostics reach the guest");
const sigHelp = await req("textDocument/signatureHelp", lines.length - 3, 8);
ok(JSON.stringify(sigHelp ?? "").includes("a: int"), "signature help");

ok((await guest.eval(`return (await ${S}.files.open("src/app.js")).kind`)) === "text", "guest opens src/app.js");
await guest.eval(`const t = ${S}.files.map.get("src/app.js"); t.insert(t.length, "console.")`);
ok(await host.until(`return ${S}.lsp.status.ts.state === "ready"`, 240000), "TypeScript server started on the host");
const jsLen = await guest.eval(`return ${S}.files.map.get("src/app.js").toString().split("\\n").length`);
const jsComp = await guest.eval(`const t = ${S}.files.map.get("src/app.js"); return await ${S}.lsp.request("src/app.js", t.length, "textDocument/completion", { position: { line: ${jsLen - 1}, character: 8 } })`);
const jsLabels = (Array.isArray(jsComp) ? jsComp : jsComp?.items ?? []).map((i) => i.label);
ok(jsLabels.includes("log") && jsLabels.includes("error"), "JS completion for console.", `${jsLabels.length} items`);

// The real suggest widget, in the guest's editor.
await guest.eval(`document.querySelector('[data-path="calc.py"]').click()`);
await guest.until(`return window.__duet.editor.file === "calc.py"`, 5000);
await guest.eval(`const ed = window.__duet.editor.editor; const m = ed.getModel(); const n = m.getLineCount(); ed.setPosition({ lineNumber: n, column: m.getLineMaxColumn(n) }); ed.focus(); ed.trigger("e2e", "editor.action.triggerSuggest", {})`);
ok(await guest.until(`return [...document.querySelectorAll(".suggest-widget .monaco-list-row")].some(r => r.textContent.includes("chdir"))`, 10000), "suggest widget shows os members in the guest editor");
await sleep(600);
await guest.shot(path.join(SHOTS, "duet-intellisense.png"));
await guest.eval(`window.__duet.editor.editor.trigger("e2e", "hideSuggestWidget", {})`);

// A package created while the server is already running must be importable
// (the user's case: src/__init__.py + src/app.py made after main.py was open).
await guest.eval(`await ${S}.files.create("pkg/__init__.py", false); await ${S}.files.create("pkg/mod.py", false)`);
await guest.eval(`await ${S}.files.open("pkg/mod.py"); const t = ${S}.files.map.get("pkg/mod.py"); t.insert(0, "VALUE = 5\\n")`);
await sleep(1500); // let the host save it
await guest.eval(`await ${S}.files.create("use.py", false); await ${S}.files.open("use.py"); const t = ${S}.files.map.get("use.py"); t.insert(0, "from pkg.mod import *\\nprint(VALUE)\\n")`);
await sleep(4000);
const useDiags = await guest.eval(`return (${S}.lsp.diagnostics.get("use.py") ?? []).map(d => d.message)`);
ok(!useDiags.some((m) => /could not be resolved|is not defined/.test(m)), "a package created after the server started resolves", JSON.stringify(useDiags));
const useHover = await guest.eval(`const t = ${S}.files.map.get("use.py"); return await ${S}.lsp.request("use.py", t.length, "textDocument/hover", { position: { line: 1, character: 8 } })`);
ok(/VALUE: (int|Literal\[5\])/.test(JSON.stringify(useHover ?? "")), "hover knows the type from the new module", JSON.stringify(useHover?.contents ?? null).slice(0, 80));

// ---- notebooks (kernel on the host, driven by the guest) ----
if (!PY_DIR) {
  console.log("SKIP  notebooks: set DUET_E2E_PYTHON_DIR to a Python Scripts dir with ipykernel");
} else {
  const NB = `${S}.notebooks`;
  ok((await guest.eval(`return (await ${S}.files.open("lesson.ipynb")).kind`)) === "notebook", "guest opens lesson.ipynb as a notebook");
  const ids = await guest.eval(`return ${NB}.cells("lesson.ipynb").toArray().map(c => c.get("id"))`);
  ok(ids.length === 3 && (await guest.eval(`return ${NB}.cells("lesson.ipynb").get(0).get("type")`)) === "markdown", "cells arrive with their types");
  const codeIds = JSON.stringify(ids.slice(1));
  const tk = Date.now();
  await guest.eval(`await ${NB}.run("lesson.ipynb", ${codeIds})`);
  const outOf = (i) => `${NB}.cells("lesson.ipynb").get(${i}).get("outputs").toArray()`;
  ok(
    await guest.until(`const o = ${outOf(2)}; return o.some(x => x.output_type === "execute_result" && String(x.data["text/plain"]).includes("42"))`, 120000),
    "Run all: x * 2 = 42 from the host kernel",
    `${Math.round((Date.now() - tk) / 1000)} s incl. kernel start`,
  );
  ok(await guest.until(`return ${outOf(1)}.some(x => x.output_type === "stream" && x.text.includes("half 21"))`, 5000), "print output streamed to the guest");
  ok((await guest.eval(`return ${NB}.cells("lesson.ipynb").get(2).get("exec")`)) === 2, "execution counts");
  let saved = null;
  for (let i = 0; i < 30 && !saved; i++) {
    await sleep(200);
    try {
      const j = JSON.parse(fs.readFileSync(path.join(proj, "lesson.ipynb"), "utf8"));
      if (j.cells[2].outputs?.length) saved = j;
    } catch {}
  }
  ok(saved && saved.cells[2].execution_count === 2 && saved.cells[1].source.join("") === 'x = 21\nprint("half", x)', "outputs saved to the .ipynb in nbformat");

  // A big plot: exercises chunked Yjs updates (> 60 KB).
  const plotId = await guest.eval(`return ${NB}.insertCell("lesson.ipynb", 3, "code", "import matplotlib.pyplot as plt\\nimport numpy as np\\nplt.figure(figsize=(12, 8), dpi=150)\\nx_ = np.linspace(0, 20, 4000)\\nplt.plot(x_, np.sin(x_) * x_)\\nplt.title('demo')\\nplt.show()")`);
  await sleep(600);
  await guest.eval(`await ${NB}.run("lesson.ipynb", ["${plotId}"])`);
  ok(
    await guest.until(`const o = ${NB}.cell("lesson.ipynb", "${plotId}").get("outputs").toArray(); return o.some(x => (x.data?.["image/png"] ?? "").length > 60000)`, 90000),
    "matplotlib plot (> 60 KB) reaches the guest",
  );
  const tableId = await guest.eval(`return ${NB}.insertCell("lesson.ipynb", 4, "code", "import pandas as pd\\npd.DataFrame({'name': ['Ali', 'Vali'], 'score': [90, 85]})")`);
  await sleep(300);
  await guest.eval(`await ${NB}.run("lesson.ipynb", ["${tableId}"])`);
  ok(await guest.until(`const o = ${NB}.cell("lesson.ipynb", "${tableId}").get("outputs").toArray(); return o.some(x => String(x.data?.["text/html"] ?? "").includes("<table"))`, 60000), "pandas DataFrame as an HTML table");

  // Errors stop "run all".
  const errId = await guest.eval(`return ${NB}.insertCell("lesson.ipynb", 5, "code", "1 / 0")`);
  const afterId = await guest.eval(`return ${NB}.insertCell("lesson.ipynb", 6, "code", "print('should not run')")`);
  await sleep(300);
  await guest.eval(`await ${NB}.run("lesson.ipynb", ["${errId}", "${afterId}"])`);
  ok(await guest.until(`return ${NB}.cell("lesson.ipynb", "${errId}").get("outputs").toArray().some(x => x.ename === "ZeroDivisionError")`, 20000), "traceback for ZeroDivisionError");
  await sleep(800);
  ok((await guest.eval(`return ${NB}.cell("lesson.ipynb", "${afterId}").get("outputs").length`)) === 0, "run-all stops at the error");

  // Interrupt a long cell. (A busy loop: on Windows ipykernel cannot cut a
  // time.sleep() short, the interrupt lands when the call returns.)
  const sleepId = await guest.eval(`return ${NB}.insertCell("lesson.ipynb", 7, "code", "n = 0\\nwhile True:\\n    n += 1")`);
  await sleep(300);
  await guest.eval(`await ${NB}.run("lesson.ipynb", ["${sleepId}"])`);
  await guest.until(`return ${NB}.cell("lesson.ipynb", "${sleepId}").get("state") === "running"`, 10000);
  await sleep(1000);
  await guest.eval(`await ${NB}.interrupt("lesson.ipynb")`);
  ok(
    await guest.until(`const c = ${NB}.cell("lesson.ipynb", "${sleepId}"); return c.get("state") === "idle" && c.get("outputs").toArray().some(x => x.ename === "KeyboardInterrupt")`, 15000),
    "Interrupt stops a running cell",
  );

  const comp = await guest.eval(`return await ${NB}.complete("lesson.ipynb", "x.bit_", 6)`);
  ok((comp?.matches ?? []).some((m) => m.includes("bit_length")), "completion from the live kernel", JSON.stringify(comp?.matches?.slice(0, 3)));

  await guest.eval(`document.querySelector('[data-path="lesson.ipynb"]').click()`);
  await guest.until(`return !!document.querySelector(".nb-cell img")`, 10000);
  await sleep(800);
  await guest.shot(path.join(SHOTS, "duet-notebook.png"));
  await host.eval(`document.querySelector('[data-path="lesson.ipynb"]').click()`);
  await sleep(800);
}

// ---- screenshots ----
await guest.eval(`for (let i = 0; i <= 24; i++) ${S}.sendPointer({ t: "s", id: 3, tool: "pen", i, a: { k: "code", file: "main.py", line: 2.9 + Math.sin(i / 4) * 0.25, col: 2 + i }, end: i === 24 })`);
await guest.eval(`${S}.sendPointer({ t: "p", a: { k: "code", file: "main.py", line: 2.2, col: 27 } })`);
await sleep(600);
await host.shot(path.join(SHOTS, "duet-host.png"));
await guest.shot(path.join(SHOTS, "duet-guest.png"));

// ---- v3: file management (from the guest) ----
const exists = (rel) => fs.existsSync(path.join(proj, rel));
const copied = await guest.eval(`return await ${S}.files.copy("calc.py", "calc.py")`);
ok(copied === "calc copy.py" && exists("calc copy.py"), "copy gets a VS Code style name", copied);
await guest.eval(`await ${S}.files.create("lib", true)`);
await guest.eval(`await ${S}.files.rename("src/app.js", "lib/app.js")`);
ok(exists("lib/app.js") && !exists("src/app.js"), "move a file into another folder");
ok(await guest.until(`return ${S}.files.map.has("lib/app.js") && !${S}.files.map.has("src/app.js")`, 5000), "open document follows the move");
await guest.eval(`await ${S}.files.trash(["calc copy.py"])`);
ok(!exists("calc copy.py"), "delete goes to the Recycle Bin");

// Host: a folder dropped from Windows Explorer is copied in.
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "duet-drop-"));
fs.mkdirSync(path.join(outside, "assets/img"), { recursive: true });
fs.writeFileSync(path.join(outside, "assets/img/logo.svg"), "<svg/>");
fs.writeFileSync(path.join(outside, "notes.txt"), "dropped by guest\n");
const imported = await host.eval(`return await ${S}.files.importPaths([${JSON.stringify(path.join(outside, "assets"))}], "lib")`);
ok(imported[0] === "lib/assets" && fs.readFileSync(path.join(proj, "lib/assets/img/logo.svg"), "utf8") === "<svg/>", "host drop copies a folder in", JSON.stringify(imported));
// Guest: a dropped file is uploaded to the host.
const upBig = path.join(outside, "upload.bin");
fs.writeFileSync(upBig, randomBytes(1024 * 1024 + 7));
const uploaded = await guest.eval(`return await ${S}.files.importPaths([${JSON.stringify(path.join(outside, "notes.txt"))}, ${JSON.stringify(upBig)}], "")`);
ok(
  uploaded.includes("notes.txt") && fs.readFileSync(path.join(proj, "notes.txt"), "utf8") === "dropped by guest\n" &&
    sha(fs.readFileSync(path.join(proj, "upload.bin"))) === sha(fs.readFileSync(upBig)),
  "guest drop uploads files to the host intact",
  JSON.stringify(uploaded),
);

// Real UI: drag main.py onto the lib folder in the guest's explorer.
await guest.eval(`document.querySelector('[data-path="lib"]').click()`); // load it
await sleep(400);
const from = await guest.center('[data-path="main.py"]');
const to = await guest.center('[data-path="lib"]');
await guest.dragFromTo(from, to);
let moved = false;
for (let i = 0; i < 40 && !moved; i++) {
  await sleep(150);
  moved = exists("lib/main.py") && !exists("main.py");
}
ok(moved, "drag and drop in the explorer moves the file");
// Real UI: F2 rename.
await guest.until(`return !!document.querySelector('[data-path="lib/main.py"]')`, 5000);
await guest.eval(`document.querySelector('[data-path="lib/main.py"]').click()`);
await guest.eval(`document.querySelector(".tree").focus()`);
await guest.key("F2", "F2", 113);
await guest.until(`return !!document.querySelector(".inline-edit input")`, 3000);
await guest.send("Input.insertText", { text: "app2" }); // replaces the selected stem
await guest.key("Enter", "Enter", 13);
let renamed = false;
for (let i = 0; i < 40 && !renamed; i++) {
  await sleep(150);
  renamed = exists("lib/app2.py");
}
ok(renamed, "F2 inline rename keeps the extension");
await sleep(500);
await guest.shot(path.join(SHOTS, "duet-explorer.png"));

// ---- v5: workbench layout, shortcuts, palette, zoom, partner visibility ----
const shown = (page, anchor) => page.eval(`return !!document.querySelector('[data-anchor="${anchor}"]')?.offsetParent`);
await guest.eval(`document.querySelector(".tree").focus()`);
await guest.combo(["ctrl"], "b", "KeyB", 66);
ok(!(await shown(guest, "explorer")), "Ctrl+B hides the explorer");
await guest.combo(["ctrl"], "`", "Backquote", 192);
ok(!(await shown(guest, "panel")), "Ctrl+` hides the terminal panel");
await guest.combo(["ctrl", "alt"], "b", "KeyB", 66);
ok(!(await shown(guest, "chat")), "Ctrl+Alt+B hides the chat");
ok(
  await host.until(`for (const [id, st] of ${S}.awareness.getStates()) if (id !== ${S}.doc.clientID && st.layout && !st.layout.explorer && !st.layout.panel && !st.layout.chat) return true; return false`, 5000),
  "the host learns which panes the guest has closed",
);
await guest.combo(["ctrl"], "b", "KeyB", 66);
await guest.combo(["ctrl"], "`", "Backquote", 192);
await guest.combo(["ctrl", "alt"], "b", "KeyB", 66);
ok((await shown(guest, "explorer")) && (await shown(guest, "panel")) && (await shown(guest, "chat")), "the same shortcuts bring them back");
ok(!!(await guest.eval(`return [...document.querySelectorAll(".xterm-host")].some(e => e.offsetParent && e.querySelector(".xterm-rows"))`)), "terminal survives being hidden");

// Zoom
const dpr0 = await guest.eval(`return devicePixelRatio`);
await guest.combo(["ctrl"], "=", "Equal", 187);
await guest.combo(["ctrl"], "=", "Equal", 187);
ok(await guest.until(`return devicePixelRatio > ${dpr0} * 1.2`, 3000), "Ctrl+= zooms in", `${dpr0} -> ${await guest.eval(`return devicePixelRatio`)}`);
ok(JSON.parse(await guest.eval(`return localStorage.getItem("duet.layout")`)).zoom === 1.25, "zoom level is remembered");

// Quick open and command palette
await guest.combo(["ctrl"], "p", "KeyP", 80);
ok(await guest.until(`return !!document.querySelector(".palette input")`, 3000), "Ctrl+P opens quick open");
await guest.until(`return document.querySelectorAll(".palette-item").length > 3`, 5000);
await guest.send("Input.insertText", { text: "clc" }); // fuzzy: calc.py
await sleep(200);
await guest.key("Enter", "Enter", 13);
ok(await guest.until(`return document.querySelector(".tab.active")?.textContent.includes("calc.py")`, 5000), "fuzzy file search opens calc.py");
await guest.combo(["ctrl", "shift"], "P", "KeyP", 80);
await guest.until(`return !!document.querySelector(".palette input")`, 3000);
await guest.send("Input.insertText", { text: "toggle explorer" });
await sleep(200);
await guest.key("Enter", "Enter", 13);
ok(!(await shown(guest, "explorer")), "command palette runs a command");
await guest.combo(["ctrl"], "b", "KeyB", 66);

// A long file the guest sees less of (zoomed in): the host's preview shades the rest.
fs.writeFileSync(path.join(proj, "long.py"), Array.from({ length: 150 }, (_, i) => `line_${i + 1} = ${i + 1}  # ${"x".repeat(i % 7 === 0 ? 120 : 10)}`).join("\n") + "\n");
// Opening calc.py by hand turned follow off (as in VS Code Live Share); turn it back on.
if (!(await guest.eval(`return !!document.querySelector(".tb-btn.on svg.lucide-eye")`))) await guest.combo(["ctrl", "alt"], "f", "KeyF", 70);
await host.eval(`document.querySelector('[data-path="long.py"]')?.click()`);
await sleep(300);
await host.eval(`await new Promise(r => setTimeout(r, 300)); document.querySelector('[data-path="long.py"]')?.click()`);
ok(await guest.until(`return document.querySelector(".tab.active")?.textContent.includes("long.py")`, 10000), "guest follows into long.py");
await sleep(800);
const views = await host.eval(`
  let peer = null; for (const [id, st] of ${S}.awareness.getStates()) if (id !== ${S}.doc.clientID) peer = st.view;
  const mine = ${S}.awareness.getLocalState().view; return { peer, mine }`);
ok(views.peer && views.mine && views.peer.file === "long.py" && views.peer.bottom < views.mine.bottom, "host knows the guest sees fewer lines", `guest ${views.peer?.bottom?.toFixed(1)} vs host ${views.mine?.bottom?.toFixed(1)}`);
await host.combo(["ctrl", "alt"], "v", "KeyV", 86);
ok(await host.until(`const c = document.querySelector(".visibility-overlay"); return !!c && c.style.display !== "none"`, 3000), "Ctrl+Alt+V turns the visibility preview on");
// The guest points at line 130, far below what the host shows: the pointer docks with a hint.
await guest.eval(`${S}.sendPointer({ t: "p", a: { k: "code", file: "long.py", line: 130.5, col: 4 } })`);
ok(await host.until(`return /line 130/.test(document.querySelector(".remote-pointer .cursor-hint")?.textContent ?? "")`, 5000), "an off-screen pointer docks at the edge with its line");
await sleep(500);
await host.shot(path.join(SHOTS, "duet-visibility.png"));
await host.combo(["ctrl", "alt"], "v", "KeyV", 86);
await guest.combo(["ctrl"], "0", "Digit0", 48);

// Narrow window: the workbench must still fit.
await guest.send("Emulation.setDeviceMetricsOverride", { width: 640, height: 520, deviceScaleFactor: 1, mobile: false });
await sleep(800);
const fits = await guest.eval(`return document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector(".tb-right").getBoundingClientRect().right <= innerWidth + 1`);
ok(fits, "a 640 px wide window still fits the workbench");
const codeW = await guest.eval(`return Math.round(document.querySelector(".editor-wrap").getBoundingClientRect().width)`);
ok(!(await shown(guest, "chat")) && codeW >= 300, "narrow window folds the chat away to give the code room", `code ${codeW}px`);
await guest.shot(path.join(SHOTS, "duet-narrow.png"));
await guest.send("Emulation.clearDeviceMetricsOverride", {});
await sleep(400);

// ---- reconnect ----
const tr = Date.now();
await guest.eval(`${S}.link.pc.close()`);
ok(await guest.until(`return ${S}.state !== "connected"`, 15000), "guest notices the drop");
const back = (await host.until(`return ${S}.state === "connected"`, 40000)) && (await guest.until(`return ${S}.state === "connected"`, 40000));
ok(back, "reconnected through signaling", `${Date.now() - tr} ms`);
await guest.eval(`const t = ${S}.files.map.get("lib/app2.py"); t.insert(0, "# after reconnect\\n")`);
let disk2 = "";
for (let i = 0; i < 40 && !disk2.includes("after reconnect"); i++) {
  await sleep(250);
  disk2 = fs.readFileSync(path.join(proj, "lib/app2.py"), "utf8");
}
ok(disk2.startsWith("# after reconnect"), "editing works after reconnect");
ok(await guest.until(`return ${S}.tunnels.ports.some(p => p.port === ${WEB_PORT})`, 8000), "shared ports restored after reconnect");
const after = await (await fetch(`http://127.0.0.1:${await guest.eval(`return ${S}.tunnels.ports.find(p => p.port === ${WEB_PORT}).local`)}/index.html`)).text();
ok(after === "<h1>Duet</h1>\n", "tunnel works after reconnect");

console.log(`\n${failures ? failures + " FAILED" : "ALL PASSED"} — screenshots in ${SHOTS}`);
cleanup();
process.exit(failures ? 1 : 0);
