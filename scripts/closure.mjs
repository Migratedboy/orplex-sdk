// closure.mjs — compute the transitive import closure of the tool layer so the
// SDK copy is complete on the first try instead of after ten build failures.
import fs from "node:fs";
import path from "node:path";

const APP = "D:/orplex";
const LIB = path.join(APP, "src/lib");

const entries = [
  "tool-definitions.ts",
  "tool-chain.ts",
  "tool-hooks.ts",
  "tool-text.ts",
  "exec-guard.ts",
  "risk-classifier.ts",
  "constants.ts",
  "failure-memory.ts",
  "virtual-fs.ts",
  "file-history.ts",
  "approval-store.ts",
  "agent-events.ts",
  "stream-reader.ts",
  "api-base.ts",
  "user-skills.ts",
  "skills.ts",
  "plugin-bundles.ts",
  "mcp-client.ts",
  "mcp-gateway.ts",
  "mcp-catalog.ts",
  "agent/native-tools.ts",
  "agent/file-ops.ts",
  "agent/serve-helpers.ts",
  "agent/archive-extract.ts",
  "agent/mcp-lane.ts",
  "agent/loop-engine.ts",
  "plugins/types.ts",
  "plugins/registry.ts",
  "plugins/initializer.ts",
];

const resolveSpec = (spec, fromFile) => {
  let p = null;
  if (spec.startsWith("@/lib/")) p = path.join(LIB, spec.slice("@/lib/".length));
  else if (spec.startsWith("./") || spec.startsWith("../")) p = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const cand of [p + ".ts", p + ".tsx", path.join(p, "index.ts")]) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
};

const seen = new Map();
const queue = entries.map((e) => path.join(LIB, e));

while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  if (!fs.existsSync(file)) {
    seen.set(file, { missing: true });
    continue;
  }
  const src = fs.readFileSync(file, "utf8");
  const specs = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])
    .concat([...src.matchAll(/import\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]));
  const rel = [];
  for (const s of specs) {
    const r = resolveSpec(s, file);
    if (r) rel.push(r);
  }
  seen.set(file, {
    missing: false,
    externals: specs.filter((s) => !s.startsWith(".") && !s.startsWith("@/")),
    own: specs.filter((s) => s.startsWith("@/") && !s.startsWith("@/lib/")),
    deps: rel,
  });
  for (const r of rel) queue.push(r);
}

const rows = [];
for (const [file, info] of seen) {
  if (info.missing) {
    rows.push({ file: path.relative(APP, file), missing: true });
    continue;
  }
  rows.push({
    file: path.relative(APP, file),
    nextReact: info.externals.filter((e) => /^(next|next-auth|react|@prisma)/.test(e)),
    externals: [...new Set(info.externals)],
  });
}

const missing = rows.filter((r) => r.missing);
const coupled = rows.filter((r) => r.nextReact && r.nextReact.length);
console.log(`files in closure: ${rows.length}  missing: ${missing.length}  next/prisma-coupled: ${coupled.length}`);
console.log("\n--- missing (unresolved by scanner, import-time only or generated) ---");
for (const m of missing) console.log(m.file);
console.log("\n--- coupled to next/react/prisma (must become ports or stay in app) ---");
for (const c of coupled) console.log(`${c.file}  ← ${c.nextReact.join(",")}`);
console.log("\n--- externals ---");
const ext = new Set();
for (const r of rows) (r.externals || []).forEach((e) => ext.add(e));
console.log([...ext].sort().join(", "));
console.log("\n--- all files ---");
console.log(rows.filter((r) => !r.missing).map((r) => r.file.replace("src/lib/", "")).sort().join("\n"));
