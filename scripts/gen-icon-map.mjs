// Prepares Material Icon Theme (PKief, MIT) for the explorer:
//   public/material-icons/<icon>.svg   the SVGs that the mapping uses
//   src/ui/material-icons.json         file name / extension / folder -> icon
// Runs before `npm run dev` and `npm run build` (pre-scripts in package.json).

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..");
const { generateManifest } = require("material-icon-theme");
const m = generateManifest();
const pkgDir = path.dirname(require.resolve("material-icon-theme/package.json"));

// Icon id -> svg file name (ids and file names usually match, not always).
const fileOf = {};
for (const [id, def] of Object.entries(m.iconDefinitions)) fileOf[id] = path.basename(def.iconPath);

const lower = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
const map = {
  file: m.file,
  folder: m.folder,
  folderExpanded: m.folderExpanded,
  fileNames: lower(m.fileNames),
  fileExtensions: lower(m.fileExtensions),
  folderNames: lower(m.folderNames),
  folderNamesExpanded: lower(m.folderNamesExpanded),
  // Language ids for extensions VS Code maps through a language, not a name.
  languageIds: m.languageIds ?? {},
  files: fileOf,
};

const used = new Set([map.file, map.folder, map.folderExpanded]);
for (const o of [map.fileNames, map.fileExtensions, map.folderNames, map.folderNamesExpanded, map.languageIds]) for (const v of Object.values(o)) used.add(v);

const out = path.join(ROOT, "public", "material-icons");
fs.mkdirSync(out, { recursive: true });
let copied = 0;
for (const id of used) {
  const f = fileOf[id];
  if (!f) continue;
  const src = path.join(pkgDir, "icons", f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(out, f));
    copied++;
  }
}
fs.writeFileSync(path.join(ROOT, "src", "ui", "material-icons.json"), JSON.stringify(map));
console.log(`material icons: ${copied} svgs, ${Object.keys(map.fileExtensions).length} extensions, ${Object.keys(map.folderNames).length} folder names`);
