// runtime-config.ts — the SDK's one knobs object.
//
// Every production behaviour that used to be a hard-coded const (MCP call
// timeout, respawn policy, env inheritance, tool routing, arg validation) reads
// from here. The defaults are chosen to reproduce the behaviour of 0.3.x byte
// for byte, so an existing host that never calls configureAgentRuntime() sees
// no change except where a default was deliberately hardened (env scoping, arg
// validation) — both documented in CHANGELOG.md.
//
// Read it through getAgentRuntimeConfig(): it returns a frozen snapshot with
// every field present, so call sites never repeat `??` fallbacks.

/** Exponential respawn policy for stdio MCP servers. */
export interface McpRespawnPolicy {
  /** Total attempts per connect (1 = no retry, the 0.3.x behaviour). */
  maxAttempts: number;
  /** First backoff delay; doubles per attempt. */
  baseDelayMs: number;
  /** Ceiling for a single backoff delay. */
  maxDelayMs: number;
}

/**
 * How a spawned MCP child process gets its environment.
 *
 *   "manifest" (default) — only the variables the server's manifest declares,
 *                plus a small baseline of OS-owned variables (PATH, TEMP,
 *                SystemRoot, APPDATA…). The host app's own secrets are never
 *                inherited: a marketplace server runs third-party code via
 *                npx/uvx and must not see NEXTAUTH_SECRET or DATABASE_URL.
 *   "inherit"  — the 0.3.x behaviour ({ ...process.env, ...cfg.env }). Kept for
 *                servers that genuinely need an undeclared host variable; a
 *                host that sets this owns the risk.
 */
export type McpEnvMode = "manifest" | "inherit";

export interface McpEnvPolicy {
  mode: McpEnvMode;
  /** Extra host variables to forward in "manifest" mode (names only). */
  allowlist: string[];
}

/** Minimal structured logger — hosts route this into their own sink. */
export interface SdkLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface AgentRuntimeConfig {
  // ── MCP transport ────────────────────────────────────────────────────────
  /** One stdio tool call, in milliseconds. 0 disables the ceiling. */
  mcpToolTimeoutMs: number;
  /** One remote (streamable HTTP) call, in milliseconds. */
  mcpHttpTimeoutMs: number;
  /** How long a freshly spawned server gets to answer initialize, ms. */
  mcpStartupTimeoutMs: number;
  /** Respawn policy for a crashed/unresponsive stdio server. */
  mcpRespawn: McpRespawnPolicy;
  /** Child-process environment policy (see McpEnvMode). */
  mcpEnv: McpEnvPolicy;

  // ── Tool surface ─────────────────────────────────────────────────────────
  /** Rank MCP tools per prompt when the roster is larger than maxActiveTools. */
  enableDynamicToolRouting: boolean;
  /** Roster size above which routing kicks in (and the cap above which it must). */
  maxActiveTools: number;
  /** Tool names that are never routed away. */
  pinnedTools: string[];
  /** Validate tool-call arguments against the tool's JSON schema first. */
  validateToolArgs: boolean;

  // ── Diagnostics ──────────────────────────────────────────────────────────
  logger: SdkLogger;
}

const CONSOLE_LOGGER: SdkLogger = {
  debug: () => {},
  info: (m, meta) => console.info(`[orplex-sdk] ${m}`, meta ?? ""),
  warn: (m, meta) => console.warn(`[orplex-sdk] ${m}`, meta ?? ""),
  error: (m, meta) => console.error(`[orplex-sdk] ${m}`, meta ?? ""),
};

/** Defaults = 0.3.x behaviour, except env scoping + arg validation (hardened). */
const DEFAULTS: AgentRuntimeConfig = {
  mcpToolTimeoutMs: 120_000,
  mcpHttpTimeoutMs: 30_000,
  mcpStartupTimeoutMs: 15_000,
  mcpRespawn: { maxAttempts: 1, baseDelayMs: 500, maxDelayMs: 4_000 },
  mcpEnv: { mode: "manifest", allowlist: [] },
  enableDynamicToolRouting: false,
  maxActiveTools: 15,
  pinnedTools: [],
  validateToolArgs: true,
  logger: CONSOLE_LOGGER,
};

let current: AgentRuntimeConfig = { ...DEFAULTS };

function positiveInt(value: unknown, fallback: number, field: string, logger: SdkLogger): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    logger.warn(`ignoring invalid ${field}`, { value, kept: fallback });
    return fallback;
  }
  return Math.floor(value);
}

/**
 * Configure the SDK for this process. Call once at startup; partial objects are
 * merged onto the previous config, so a host may tune one field per concern.
 * Throws nothing — bad values fall back with a warning, because a config typo
 * must not take down the tool layer.
 */
export function configureAgentRuntime(partial: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  const logger = partial.logger ?? current.logger;
  const merged: AgentRuntimeConfig = {
    ...current,
    ...partial,
    logger,
    mcpRespawn: { ...current.mcpRespawn, ...(partial.mcpRespawn ?? {}) },
    mcpEnv: { ...current.mcpEnv, ...(partial.mcpEnv ?? {}) },
    pinnedTools: partial.pinnedTools ? [...partial.pinnedTools] : [...current.pinnedTools],
  };

  merged.mcpToolTimeoutMs = positiveInt(merged.mcpToolTimeoutMs, DEFAULTS.mcpToolTimeoutMs, "mcpToolTimeoutMs", logger);
  merged.mcpHttpTimeoutMs = positiveInt(merged.mcpHttpTimeoutMs, DEFAULTS.mcpHttpTimeoutMs, "mcpHttpTimeoutMs", logger);
  merged.mcpStartupTimeoutMs = positiveInt(merged.mcpStartupTimeoutMs, DEFAULTS.mcpStartupTimeoutMs, "mcpStartupTimeoutMs", logger);
  merged.maxActiveTools = positiveInt(merged.maxActiveTools, DEFAULTS.maxActiveTools, "maxActiveTools", logger);
  if (merged.maxActiveTools < 1) {
    logger.warn("maxActiveTools must be at least 1", { value: merged.maxActiveTools, kept: 1 });
    merged.maxActiveTools = 1;
  }
  merged.mcpRespawn.maxAttempts = Math.max(1, positiveInt(merged.mcpRespawn.maxAttempts, 1, "mcpRespawn.maxAttempts", logger));
  merged.mcpRespawn.baseDelayMs = positiveInt(merged.mcpRespawn.baseDelayMs, DEFAULTS.mcpRespawn.baseDelayMs, "mcpRespawn.baseDelayMs", logger);
  merged.mcpRespawn.maxDelayMs = Math.max(merged.mcpRespawn.baseDelayMs, positiveInt(merged.mcpRespawn.maxDelayMs, DEFAULTS.mcpRespawn.maxDelayMs, "mcpRespawn.maxDelayMs", logger));
  if (merged.mcpEnv.mode !== "manifest" && merged.mcpEnv.mode !== "inherit") {
    logger.warn("ignoring unknown mcpEnv.mode", { value: merged.mcpEnv.mode, kept: "manifest" });
    merged.mcpEnv.mode = "manifest";
  }
  merged.mcpEnv.allowlist = (merged.mcpEnv.allowlist ?? []).filter((n) => typeof n === "string" && n.length > 0);

  current = merged;
  return getAgentRuntimeConfig();
}

/** Frozen snapshot — safe to hold for the duration of one call. */
export function getAgentRuntimeConfig(): AgentRuntimeConfig {
  return Object.freeze({
    ...current,
    mcpRespawn: Object.freeze({ ...current.mcpRespawn }),
    mcpEnv: Object.freeze({ mode: current.mcpEnv.mode, allowlist: Object.freeze([...current.mcpEnv.allowlist]) as unknown as string[] }),
    pinnedTools: Object.freeze([...current.pinnedTools]) as unknown as string[],
  });
}

/** Restore defaults (tests, and a host tearing its SDK instance down). */
export function resetAgentRuntimeConfig(): void {
  current = { ...DEFAULTS };
}
