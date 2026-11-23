// The package root says "type": "module"; the CJS build lives in dist/cjs and
// must be marked commonjs or Node parses it as ESM and require() disappears.
import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
fs.mkdirSync(path.join(root, "dist", "cjs"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "cjs", "package.json"), '{\n  "type": "commonjs"\n}\n');
fs.mkdirSync(path.join(root, "dist", "esm"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "esm", "package.json"), '{\n  "type": "module"\n}\n');
console.log("wrote dist package markers");
