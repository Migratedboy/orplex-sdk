// Environment scoping for spawned MCP servers.
//
// The contract: a marketplace server is third-party code, so it gets the
// variables its manifest declares plus OS-owned basics — never the host's
// secrets. Nothing here spawns a process; these assert on the returned map.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChildEnv,
  resetEnvScopeWarnings,
  configureAgentRuntime,
  getAgentRuntimeConfig,
  resetAgentRuntimeConfig,
} from "../dist/esm/mcp.js";

const HOST = {
  PATH: "/usr/bin:/bin",
  SystemRoot: "C:\\Windows",
  TEMP: "/tmp",
  HOME: "/home/dev",
  APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
  npm_config_registry: "https://registry.npmjs.org",
  CUSTOM_HOST_VAR: "host-only",
  NEXTAUTH_SECRET: "super-secret-session-key",
  DATABASE_URL: "postgres://user:pw@db/app",
  ORPLEX_SESSION_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  GITHUB_TOKEN: "ghp_should_not_leak",
};

const SECRETS = ["NEXTAUTH_SECRET", "DATABASE_URL", "ORPLEX_SESSION_PRIVATE_KEY", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"];

function quietLogger() {
  const calls = [];
  return {
    calls,
    debug: (m, meta) => calls.push(["debug", m, meta]),
    info: (m, meta) => calls.push(["info", m, meta]),
    warn: (m, meta) => calls.push(["warn", m, meta]),
    error: (m, meta) => calls.push(["error", m, meta]),
  };
}

test.beforeEach(() => {
  resetAgentRuntimeConfig();
  resetEnvScopeWarnings();
});

test("manifest mode: declared vars + OS basics reach the child, host secrets do not", () => {
  const { env } = buildChildEnv(
    { env: { ELEVENLABS_API_KEY: "manifest-key" }, declaredEnv: ["ELEVENLABS_API_KEY"] },
    { hostEnv: HOST, label: "elevenlabs" },
  );

  assert.equal(env.ELEVENLABS_API_KEY, "manifest-key", "the manifest's variables must arrive");
  assert.equal(env.PATH, HOST.PATH, "PATH is needed to find the runtime");
  assert.equal(env.HOME, HOST.HOME);
  assert.equal(env.TEMP, HOST.TEMP);
  assert.equal(env.npm_config_registry, HOST.npm_config_registry, "package-manager prefixes are baseline");

  assert.equal(env.CUSTOM_HOST_VAR, undefined, "undeclared host variables stay home");
  for (const name of SECRETS) assert.equal(env[name], undefined, `${name} must never reach a third-party server`);
});

test("manifest mode: allowlist adds a specific host variable", () => {
  const { env } = buildChildEnv({ env: {} }, { hostEnv: HOST, allowlist: ["CUSTOM_HOST_VAR"], label: "custom" });
  assert.equal(env.CUSTOM_HOST_VAR, "host-only");
});

test("inherit mode keeps the old passthrough but still withholds secrets", () => {
  const { env, dropped } = buildChildEnv({ env: {} }, { hostEnv: HOST, mode: "inherit", label: "legacy" });
  assert.equal(env.CUSTOM_HOST_VAR, "host-only", "inherit really is a passthrough");
  for (const name of SECRETS) {
    assert.equal(env[name], undefined, `${name} is withheld even in inherit mode`);
    assert.ok(dropped.includes(name), `${name} must be reported as withheld`);
  }
});

test("the never-forward list beats an explicit allowlist", () => {
  const { env, dropped } = buildChildEnv(
    { env: {} },
    { hostEnv: HOST, allowlist: ["CUSTOM_HOST_VAR", "NEXTAUTH_SECRET"], label: "sloppy-host" },
  );
  assert.equal(env.CUSTOM_HOST_VAR, "host-only", "the legitimate entry still arrives");
  assert.equal(env.NEXTAUTH_SECRET, undefined, "a session key is not a forwarding preference");
  assert.ok(dropped.includes("NEXTAUTH_SECRET"));
});

test("undeclared manifest variables warn once per server, with names but never values", () => {
  const logger = quietLogger();
  configureAgentRuntime({ logger });
  const cfg = { env: { ELEVENLABS_API_KEY: "v1", SECRET_EXTRA: "v2" }, declaredEnv: ["ELEVENLABS_API_KEY"] };

  buildChildEnv(cfg, { hostEnv: HOST, label: "warn-once" });
  buildChildEnv(cfg, { hostEnv: HOST, label: "warn-once" });

  const warned = logger.calls.filter(([level, message]) => level === "warn" && /does not declare/.test(message));
  assert.equal(warned.length, 1, "one warning per server, not one per call");
  const meta = warned[0][2];
  assert.deepEqual(meta.names, ["SECRET_EXTRA"], "the undeclared name is named");
  assert.ok(!JSON.stringify(logger.calls).includes("v2"), "values never reach the log");
});

test("runtime config: invalid values fall back instead of throwing", () => {
  const logger = quietLogger();
  configureAgentRuntime({ logger, mcpToolTimeoutMs: -5, maxActiveTools: 0, mcpEnv: { mode: "bogus" } });
  const cfg = getAgentRuntimeConfig();
  assert.equal(cfg.mcpToolTimeoutMs, 120_000, "negative timeout keeps the default");
  assert.equal(cfg.maxActiveTools, 1, "zero active tools is clamped to 1");
  assert.equal(cfg.mcpEnv.mode, "manifest", "an unknown mode falls back to the safe one");
  assert.ok(logger.calls.length >= 3, "every rejection is reported, not silent");
});

test("runtime config: values are merged, not replaced, and snapshots are frozen", () => {
  configureAgentRuntime({ mcpRespawn: { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 2_000 } });
  configureAgentRuntime({ enableDynamicToolRouting: true });
  const cfg = getAgentRuntimeConfig();
  assert.equal(cfg.enableDynamicToolRouting, true);
  assert.equal(cfg.mcpRespawn.maxAttempts, 3, "a later partial config keeps earlier fields");
  assert.throws(() => {
    cfg.mcpToolTimeoutMs = 1;
  }, "the snapshot is frozen so a caller cannot mutate global state");
});
