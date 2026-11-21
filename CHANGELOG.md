# Changelog

All notable changes to `@orplex/sdk`. Versions follow semver; `0.x` minors may
add behaviour that existing hosts must opt into, and every such change is called
out here.

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
