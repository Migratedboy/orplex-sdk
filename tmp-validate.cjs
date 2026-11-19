const fs = require("fs");
const { validateMcpCatalog } = require("./dist/cjs/lib/mcp-catalog.js");
const bundle = JSON.parse(fs.readFileSync("D:/orplex-marketplace/catalog/bundle.json", "utf8"));
const mcp = bundle.payload.mcp ?? bundle.mcp;
console.log("entries:", mcp.length);
console.log(JSON.stringify(validateMcpCatalog(mcp)).slice(0, 400));
