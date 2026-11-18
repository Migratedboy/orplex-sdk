// vendor-lib.mjs — copy the tool-layer closure out of the app into the SDK,
// rewriting the app's "@/lib/..." alias into real relative imports.
//
// Deterministic on purpose: Phase 2 moves the layer, Phase 4 re-runs this to
// prove nothing was hand-edited in between. Skip list = the only modules that
// are genuinely app-bound (Next/NextAuth/Prisma).
import fs from "node:fs";
import path from "node:path";

const APP_LIB = "D:/orplex/src/lib";
const SDK_SRC = "D:/orplex-sdk/src";
const SDK_LIB = path.join(SDK_SRC, "lib");

const SKIP = new Set(["auth.ts", "prisma.ts", "plugin-library/domain.ts"]);

const list = fs
  .readFileSync("D:/orplex-sdk/scripts/closure.txt", "utf8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);

let copied = 0;
const rewritten = [];

for (const rel of list) {
  const srcFile = path.join(APP_LIB, rel);
  if (!fs.existsSync(srcFile) || SKIP.has(rel)) continue;
  const dstFile = path.join(SDK_LIB, rel);
  let src = fs.readFileSync(srcFile, "utf8");

  // "@/lib/agent/x" → relative path from this file's directory
  src = src.replace(/(["'])@\/lib\/([^"']+)\1/g, (_m, q, target) => {
    const abs = path.join(SDK_LIB, target);
    let relPath = path.relative(path.dirname(dstFile), abs).replace(/\\/g, "/");
    if (!relPath.startsWith(".")) relPath = `./${relPath}`;
    rewritten.push(`${rel} → ${relPath}`);
    return `${q}${relPath}${q}`;
  });

  fs.mkdirSync(path.dirname(dstFile), { recursive: true });
  fs.writeFileSync(dstFile, src, "utf8");
  copied++;
}

console.log(`vendored ${copied} modules, rewrote ${rewritten.length} alias imports`);
