// Crash recovery: a stdio server that dies must come back on its own, a bounded
// number of times, and must not be resurrected by a shutdown we initiated.
import test from "node:test";
// Spawn-based respawn tests are unreliable on Windows CI (process spawning
// differences, path handling). Skip the whole file there.
const SKIP_ON_WINDOWS = process.platform === "win32";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const client = await import("../dist/esm/lib/mcp-client.js");
const { configureAgentRuntime, resetAgentRuntimeConfig } = await import("../dist/esm/lib/runtime-config.js");

// The MCP arg gate refuses shell metacharacters, and some hosts' temp paths
// contain "!" (e.g. C:\Users\Hey!\…), so a fixture under the OS temp dir is
// rejected before it reaches the spawn — not the behaviour under test here.
// Use a stable directory under the repo root to keep the path clean everywhere.
const base = path.join(process.cwd(), ".tmp-tests");
mkdirSync(base, { recursive: true });
const dir = mkdtempSync(path.join(base, "orplex-respawn-"));

/** A grossly minimal MCP server: answers tools/list, then exits N ms later. */
function writeServer(name, { exitAfterMs = 150, tools = 1 } = {}) {
  const file = path.join(dir, `${name}.cjs`);
  writeFileSync(
    file,
    `
const tools = Array.from({ length: ${tools} }, (_, i) => ({ name: "t" + i, description: "d" + i, inputSchema: { type: "object" } }));
process.stdin.on("data", (chunk) => {
  for (const line of chunk.toString().split("\\n")) {
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools } }) + "\\n");
    }
  }
});
if (${exitAfterMs} > 0) setTimeout(() => process.exit(7), ${exitAfterMs});
process.stdin.resume();
// Ask the parent to consider us alive until we exit.
setInterval(() => {}, 1000);
`,
    "utf8",
  );
  return file;
}

const logs = [];
const logger = {
  debug: () => {},
  info: () => {},
  warn: (m, meta) => logs.push(["warn", m, meta]),
  error: (m, meta) => logs.push(["error", m, meta]),
};

test.afterEach?.(() => resetAgentRuntimeConfig());

test("a crashed server is respawned and answers again", { skip: SKIP_ON_WINDOWS }, async () => {
  resetAgentRuntimeConfig();
  configureAgentRuntime({ mcpRespawn: { maxAttempts: 3, baseDelayMs: 20, maxDelayMs: 60 }, logger });
  const script = writeServer("respawn-ok", { exitAfterMs: 250, tools: 2 });
  const handle = await client.getMcpServerForRun("respawn-ok", { "respawn-ok": { command: process.execPath, args: [script] } }, "user-1");
  const first = await handle.listTools();
  assert.equal(first.length, 2);
  await new Promise((r) => setTimeout(r, 600)); // let it exit and come back
  const second = await handle.listTools();
  assert.equal(second.length, 2, "the server is usable after the crash");
  assert.ok(logs.some(([level, msg]) => level === "warn" && /respawning/.test(msg)), "the respawn is logged");
  await client.shutdownAccountSession("respawn-ok", { "respawn-ok": { command: process.execPath, args: [script] } }, "user-1");
});

test("respawn attempts are bounded and then reported as fatal", { skip: SKIP_ON_WINDOWS }, async () => {
  resetAgentRuntimeConfig();
  logs.length = 0;
  configureAgentRuntime({ mcpRespawn: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20 }, logger });
  const script = writeServer("respawn-dead", { exitAfterMs: 60, tools: 1 });
  const cfg = { "respawn-dead": { command: process.execPath, args: [script] } };
  const handle = await client.getMcpServerForRun("respawn-dead", cfg, "user-2");
  await handle.listTools().catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  const errors = logs.filter(([level]) => level === "error");
  assert.ok(errors.some(([, msg]) => /keeps crashing/.test(msg)), `expected a give-up log, got ${JSON.stringify(logs)}`);
  await client.shutdownAccountSession("respawn-dead", cfg, "user-2");
});

test("the default policy does not respawn at all", { skip: SKIP_ON_WINDOWS }, async () => {
  resetAgentRuntimeConfig();
  const policy = (await import("../dist/esm/lib/runtime-config.js")).getAgentRuntimeConfig().mcpRespawn;
  assert.equal(policy.maxAttempts, 1, "0.3.x behaviour is the default: no silent retries");
});

test("shutdown does not trigger a respawn of the process it killed", { skip: SKIP_ON_WINDOWS }, async () => {
  resetAgentRuntimeConfig();
  logs.length = 0;
  configureAgentRuntime({ mcpRespawn: { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 20 }, logger });
  const script = writeServer("respawn-quiet", { exitAfterMs: 0, tools: 1 });
  const cfg = { "respawn-quiet": { command: process.execPath, args: [script] } };
  const handle = await client.getMcpServerForRun("respawn-quiet", cfg, "user-3");
  await client.shutdownAccountSession("respawn-quiet", cfg, "user-3");
  assert.ok(
    !logs.some(([level, msg, meta]) => level === "warn" && /respawning/.test(msg) && meta?.server === "respawn-quiet"),
    "our own kill is not a crash",
  );
});
