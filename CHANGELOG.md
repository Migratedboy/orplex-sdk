# Changelog

All notable changes to `@orplex/sdk`. Versions follow semver; `0.x` minors may
add behaviour that existing hosts must opt into, and every such change is called
out here.

## 0.5.0 — 2026-11-21

Closes the loop on the four knobs 0.4.0 shipped but did not wire, and closes the
marketplace replay/ambiguity gaps.

### Tool surface

- **Dynamic tool routing works.** `enableDynamicToolRouting`, `maxActiveTools`
  and `pinnedTools` were merged into the config and read by nothing. New
  `routeTools()` ranks the roster against the current turn (name > server >
  description hits), `buildMcpRoster({ route })` takes the active subset, and
  every other tool stays reachable through `mcp_search_tools` /
  `mcp_describe_tool` / `mcp_call`. Off by default: a host that never opts in
  gets the 0.4.0 prompt byte for byte. `McpRoster.routing` reports what was
  hidden, and `mcpPromptSection()` lists hidden names instead of dropping them.
- **`validateToolArgs` is enforced.** New zero-dependency draft-07 subset runs
  before `tools/call`; a bad argument bag fails locally with `MCP_INVALID_ARGS`
  and the exact fields, instead of a late server-worded rejection after a
  partial side effect.

### Reliability

- **Crash recovery works.** `mcpRespawn` was dead config: a server that died
  stayed dead until the app restarted. A crashed child now respawns with bounded
  exponential backoff, a child that has stayed up for 30 s resets the budget (so
  a healthy server may crash again later), and an exhausted budget logs
  "keeps crashing; giving up". `maxAttempts: 1` — the default — still means no
  retries.
- Shutdown never triggers a respawn of the process it was asked to kill.

### Marketplace

- **Index schemaVersion 2.** `seq` (monotonic publish counter), `expiresAt`,
  `revoked[]`, `keyId` and an optional `keys[]` keyring. `checkIndex()` refuses
  an expired index, an unknown schema, a missing host key, or a bad signature;
  `resolveCatalog()` drops revoked ids. Rotation no longer needs a new app build.
- **Per-item digest v2.** v1 hashed `name + "\n" + content` joined by "\n", so a
  file whose content starts with `other.txt\n…` collides with a genuine two-file
  tree — two different item trees could share one digest. v2 hashes
  `sha256(name NUL content)` per file (a NUL cannot appear in a path) and joins
  the fixed-width hex digests. `verifyItemFiles()` follows the item's declared
  `digest`, so v1 indexes keep verifying.
- `schemaVersion` is enforced instead of stored and ignored.

### Tests

61 contract tests (was 31): routing, argument validation, digest ambiguity (the
collision is asserted, not asserted away), index v2 gates, respawn bounds.

## 0.4.0 — 2026-11-20

Production hardening. Existing hosts keep working: every new setting has a
default that preserves 0.3.x behaviour, except the two hardening defaults called
out below (env scoping, argument validation).

### Security

- **Spawned MCP servers no longer inherit the host environment.**
  `mcp-client.ts` used to launch third-party servers (`npx`/`uvx` shims) with
  `{ ...process.env, ...cfg.env }`, handing them `NEXTAUTH_SECRET`,
  `DATABASE_URL`, session signing keys and every other host variable. Children
  now receive only the variables their manifest declares plus an OS baseline
  (`PATH`, `TEMP`, `SystemRoot`, `APPDATA`, package-manager prefixes), filtered
  through a never-forward list that also covers `*_TOKEN`/`*_SECRET`/`*_API_KEY`
  and the app's own `ORPLEX_*`/`NEXTAUTH_*` names.
  - New: `buildChildEnv()`, `MCP_ENV_BASELINE`, `configureAgentRuntime({ mcpEnv })`.
  - Opt-out: `configureAgentRuntime({ mcpEnv: { mode: "inherit" } })` restores
    the 0.3.x passthrough — secrets are still withheld.
  - New field: `McpServerConfig.declaredEnv` (host passes the manifest's
    `stdio.env[].name` list); undeclared extras produce one warning per server.

### Reliability

- **Global shutdown.** `shutdownAllMcp()` is exported and sweeps every tracked
  child, not just cached sessions. Hosts call it from `before-quit`.
- **Real process-tree kill.** `shutdown()` used `proc.kill()` on a `cmd.exe`
  shim, leaving `cmd → npx → node` grandchildren alive. A PID registry
  (`trackProcess`/`listTrackedProcesses`/`killTree`) now terminates the tree:
  `taskkill /T /F` on Windows, SIGTERM→SIGKILL on POSIX.
- **Configurable timeouts.** `mcpToolTimeoutMs` (default 120 s, `0` disables),
  `mcpHttpTimeoutMs` (30 s), `mcpStartupTimeoutMs` (15 s — previously a dead
  constant).
- **Typed errors.** `SdkError` with stable codes (`MCP_TIMEOUT`, `MCP_CRASHED`,
  `MCP_SPAWN_FAILED`, `MCP_INVALID_ARGS`, …), a `retryable` flag and a `hint`
  that formats into the tool result the model reads. `isSdkError()` works across
  IPC boundaries; messages are unchanged for existing string matchers.

### Tooling

- `configureAgentRuntime()` / `getAgentRuntimeConfig()` / `resetAgentRuntimeConfig()`
  — one merged, frozen configuration object; invalid values warn and fall back
  instead of throwing.
- `exports` now includes `./package.json`; CI verifies that every subpath loads
  in CJS **and** ESM with the same surface (`scripts/verify-exports.mjs`,
  110 subpaths).
- GitHub Actions: `ci.yml` (Node 20/22/24 × Linux/Windows, typecheck, build,
  export parity, tests, tarball size budget) and `publish.yml` (tag-driven,
  `--provenance`).

## 0.3.1

- Catalogues became marketplace data instead of compiled arrays (breaking for
  hosts that imported the built-in catalogues directly; see the migration note
  in README).

## 0.3.0

- First publishable extraction: agent loop, native tools, MCP client/gateway,
  skills, plugins, cloud client and the signed marketplace resolver.
