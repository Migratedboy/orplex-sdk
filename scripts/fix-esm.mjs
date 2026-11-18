// fix-esm.mjs — Node ESM needs explicit file extensions; TypeScript emits the
// source specifier verbatim. Rewrite relative specifiers in dist/esm once,
// resolving directory imports to "<dir>/index.js".
import fs from "node:fs";
import path from "node:path";

const ROOT = "D:/orplex-sdk/dist/esm";

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|d\.ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

let changed = 0;
for (const file of walk(ROOT)) {
  const before = fs.readFileSync(file, "utf8");
  const after = before.replace(
    /(from\s+|import\s*\(\s*|require\s*\(\s*)(["'])(\.[^"']+)\2/g,
    (match, prefix, quote, spec) => {
      // Only plain relative specifiers. A template literal that CONTAINS an
      // import statement (generated code, docs) must not be rewritten.
      if (!/^\.{1,2}(\/[A-Za-z0-9._-]+)*$/.test(spec)) return match;
      if (/\.(js|json|mjs|cjs)$/.test(spec)) return match;
      const target = path.resolve(path.dirname(file), spec);
      // Prefer a sibling FILE over a same-named directory: src/lib/plugin-library.ts
      // and src/lib/plugin-library/ both exist, and the lockfile decides which.
      const fileWins = fs.existsSync(`${target}.js`);
      const isDir = !fileWins && fs.existsSync(target) && fs.statSync(target).isDirectory();
      const next = isDir ? `${spec}/index.js` : `${spec}.js`;
      return `${prefix}${quote}${next}${quote}`;
    },
  );
  if (after !== before) {
    fs.writeFileSync(file, after, "utf8");
    changed++;
  }
}
console.log(`fix-esm: rewrote specifiers in ${changed} files`);
