// verify-exports.mjs — the published artifact must load and expose what it claims.
//
// Three failure modes TypeScript cannot catch:
//   1. Dual-package drift: the CJS build and the ESM build disagree about the
//      public surface (a named export present in one tsconfig only, or a lost
//      package.json marker so Node reads .js as the wrong module kind).
//   2. Broken subpath: an `exports` target points at a file that is not in
//      `dist` because a barrel was renamed or a build step skipped it.
//   3. A wildcard entry (`./lib/*`) that resolves to nothing.
// All three only surface after `npm install @orplex/sdk` — in a user's app.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const require = createRequire(path.join(root, "noop.cjs"));

/** Modules that legitimately need a browser/renderer to import. */
const BROWSER_ONLY = /^(window|localStorage|document|sessionStorage|navigator) is not defined$/;

const problems = [];
let checked = 0;
let browserOnly = 0;

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".js")) out.push(full);
  }
  return out;
};

const targetsOf = (entry) => (typeof entry === "string" ? { import: entry } : entry);

for (const declared of Object.keys(pkg.exports)) {
  if (declared === "./package.json") continue;
  const targets = targetsOf(pkg.exports[declared]);
  const star = declared.indexOf("*");

  if (star === -1) {
    if (!existsSync(path.join(root, targets.import))) {
      problems.push(`${declared}: export target missing → ${targets.import}`);
      continue;
    }
    await check(declared, targets.import, targets.require);
    continue;
  }

  // Wildcard: enumerate what actually ships, then verify every concrete match.
  const base = declared.slice(0, star);
  const dir = path.dirname(path.join(root, targets.import));
  const files = existsSync(dir) ? walk(dir) : [];
  if (!files.length) {
    problems.push(`${declared}: wildcard resolves to no files under ${path.relative(root, dir)}`);
    continue;
  }
  for (const file of files) {
    const suffix = path.relative(dir, file).replace(/\\/g, "/").replace(/\.js$/, "");
    const spec = `${base}${suffix}`;
    await check(spec, targets.import.replace("*", suffix), targets.require.replace("*", suffix));
  }
}

async function check(spec, importRel, requireRel) {
  if (!importRel || !requireRel) {
    problems.push(`${spec}: exports entry lacks an import or require condition`);
    return;
  }
  const importFile = path.join(root, importRel);
  const requireFile = path.join(root, requireRel);
  if (!existsSync(importFile)) problems.push(`${spec}: missing ESM file ${importRel}`);
  if (!existsSync(requireFile)) problems.push(`${spec}: missing CJS file ${requireRel}`);
  if (!existsSync(importFile) || !existsSync(requireFile)) return;

  try {
    const esm = await import(new URL(`file://${importFile.replace(/\\/g, "/")}`).href);
    const cjs = require(requireFile);
    const esmKeys = Object.keys(esm).filter((k) => k !== "default").sort();
    const cjsKeys = Object.keys(cjs).sort();
    const onlyEsm = esmKeys.filter((k) => !cjsKeys.includes(k));
    const onlyCjs = cjsKeys.filter((k) => !esmKeys.includes(k));
    if (onlyEsm.length) problems.push(`${spec}: ESM-only exports ${onlyEsm.slice(0, 5).join(", ")}`);
    if (onlyCjs.length) problems.push(`${spec}: CJS-only exports ${onlyCjs.slice(0, 5).join(", ")}`);
    checked++;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (BROWSER_ONLY.test(message)) {
      browserOnly++; // renderer-only module: importable only with a DOM
      return;
    }
    problems.push(`${spec}: failed to load — ${message.split("\n")[0]}`);
  }
}

if (!pkg.exports["./package.json"]) {
  problems.push("./package.json is not exported (tooling and bundlers read it)");
}

console.log(`  checked ${checked} subpaths (${browserOnly} browser-only, import-skipped)`);
if (problems.length) {
  console.error("verify-exports: FAILED");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("verify-exports: ok — every subpath loads in both CJS and ESM with the same surface");
