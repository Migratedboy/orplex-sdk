// The package root says "type": "module"; the CJS build lives in dist/cjs and
// must be marked commonjs or Node parses it as ESM and require() disappears.
import fs from "node:fs";
fs.mkdirSync("D:/orplex-sdk/dist/cjs", { recursive: true });
fs.writeFileSync("D:/orplex-sdk/dist/cjs/package.json", '{\n  "type": "commonjs"\n}\n');
fs.mkdirSync("D:/orplex-sdk/dist/esm", { recursive: true });
fs.writeFileSync("D:/orplex-sdk/dist/esm/package.json", '{\n  "type": "module"\n}\n');
console.log("wrote dist package markers");
