// mcp-client.ts — Minimal MCP (Model Context Protocol) stdio client.
//
// Deliberately implemented against the wire protocol instead of pulling in
// @modelcontextprotocol/sdk (a heavy dependency tree for a solo, low-spec
// machine): MCP stdio transport is newline-delimited JSON-RPC 2.0, which is
// ~150 lines here. Servers are declared in orplex.config.json under
// "mcpServers" — the SAME config shape Claude Code uses, so existing server
// configs work unmodified.
//
// Low-spec budget (8GB laptop):
//   - max 2 server processes at once (extra configured servers are refused
//     with an honest error, not silently dropped)
//   - 120s timeout on every tool call
//   - 5 minutes idle → server process killed (reaped on next use)
//   - processes die with the parent (detached: false)

import { spawn } from "child_process";
import { createHash } from "crypto";
import { getAgentRuntimeConfig } from "./runtime-config";
import { SdkError, toSdkError } from "./errors";
import { buildChildEnv } from "./mcp/env-scope";
import { validateToolArgs } from "./mcp/validate-args";
import { trackProcess, untrackProcess, killTree, shutdownAllSpawnedProcesses } from "./mcp/process-registry";

const MAX_SERVERS = 2;
const IDLE_REAP_MS = 5 * 60_000;
/** A child that survives this long is healthy, not crash-looping. */
const STABLE_MS = 30_000;

/** The configured stdio call ceiling (0 = no ceiling). Read per call, not cached. */
function callTimeoutMs(): number {
  return getAgentRuntimeConfig().mcpToolTimeoutMs;
}

export interface McpToolDef {
  server: string;
  name: string;
  description: string;
  inputSchema: unknown;
}

/** Roster name for an MCP tool — the convention Claude Code established. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

/** Parse `mcp__<server>__<tool>` back into parts (null if not an MCP name). */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  // Split at the LAST __ so server names containing single underscores work.
  const last = rest.lastIndexOf("__");
  if (last <= 0 || last === rest.length - 2) return null;
  return { server: rest.slice(0, last), tool: rest.slice(last + 2) };
}

export interface McpServerHandle {
  server: string;
  listTools(): Promise<McpToolDef[]>;
  callTool(toolName: string, args: Record<string, unknown>): Promise<string>;
  shutdown(): Promise<void>;
}

interface Session {
  handle: McpServerHandle;
  lastUsed: number;
}

const sessions = new Map<string, Session>();

// ── Config ─────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Names of the environment variables this server's manifest declares it
   * accepts (marketplace `stdio.env[].name`). Used to warn when the host hands
   * over something undeclared — the scope itself is enforced by env-scope.ts.
   */
  declaredEnv?: string[];
}

/** Read `mcpServers` from orplex.config.json (Claude Code config shape). */
export function loadMcpConfig(configDir: string): Record<string, McpServerConfig> {
  try {
    // Lazy fs import keeps this module importable from any bundle.

    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const raw = fs.readFileSync(path.join(configDir, "orplex.config.json"), "utf8");
    const parsed = JSON.parse(raw);
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== "object") return {};
    const out: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(servers)) {
      if (cfg && typeof cfg === "object" && typeof (cfg as McpServerConfig).command === "string") {
        out[name] = cfg as McpServerConfig;
      }
    }
    return out;
  } catch {
    return {};
  }
}

// ── JSON-RPC over stdio ────────────────────────────────────────────────────

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class StdioMcpServer implements McpServerHandle {
  server: string;
  private proc: ReturnType<typeof spawn> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private tools: McpToolDef[] | null = null;
  private exited = false;
  /** Last spawn config — respawn after a crash needs it. */
  private cfg: McpServerConfig | null = null;
  /** Consecutive crash respawns since the last STABLE period. */
  private respawns = 0;
  /** When the current child was spawned — see the stability window below. */
  private spawnedAt = 0;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by shutdown(): an exit we caused is not a crash. */
  private closing = false;

  /** True while a live child process is attached. */
  get alive(): boolean {
    return !!this.proc && !this.exited;
  }

  constructor(server: string) {
    this.server = server;
  }

  private async ensureProc(cfg: McpServerConfig): Promise<void> {
    if (this.proc && !this.exited) return;
    this.cfg = cfg;
    this.buffer = "";
    this.tools = null;

    const active = [...sessions.values()].filter((s) => s.handle !== this).length;
    if (active >= MAX_SERVERS) {
      throw new Error(`MCP server limit reached (${MAX_SERVERS}) — disable a server in orplex.config.json to add another`);
    }

    // Windows: npx/uvx are .cmd shims — spawn needs a shell to resolve them
    // (bare spawn("npx") dies instantly with ENOENT → EPIPE on first write).
    // Absolute .exe paths skip the shim. On POSIX the direct spawn is right.
    // Defense in depth for rows saved before the connect-time gate: refuse
    // shell metacharacters here too (fail closed with a re-save hint).
    // Exception: `${VAR}` spans are mcp-remote's sanctioned env
    // interpolation channel (its header secrets MUST arrive this way —
    // e.g. "Authorization:${ELEVENLABS_API_KEY}"). cmd.exe leaves `${}`
    // literal and the POSIX spawn is array-based here, so every occurrence
    // is inert in both real spawn modes; `$(…)`, bare `$`, `%VAR%`, and
    // backticks are still refused.
    const varTemplate = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g;
    if (typeof cfg.command !== "string" || cfg.command.length === 0 || cfg.command.length > 2048 || /[";&|$`()\n\r<>^%!]/.test(cfg.command.replace(varTemplate, ""))) {
      throw new Error(
        `MCP server "${this.server}" has an unsafe stored command — re-save the connector to pass the safety check`
      );
    }
    for (const a of cfg.args ?? []) {
      if (typeof a !== "string" || a.length > 2048 || /[";&|$`()\n\r<>^%!]/.test(a.replace(varTemplate, ""))) {
        throw new Error(
          `MCP server "${this.server}" has unsafe stored arguments — re-save the connector to pass the safety check`
        );
      }
    }
    const useShell = process.platform === "win32" && !/\.exe$/i.test(cfg.command);
    const command = useShell ? "cmd" : cfg.command;
    // Quote args carrying whitespace (e.g. "C:\My Tools\x") so they survive
    // as single argv elements; metacharacters were rejected above, so the
    // quotes cannot be broken out of.
    const quote = (a: string) => (/\s/.test(a) ? `"${a}"` : a);
    const args = useShell
      ? ["/d", "/s", "/c", cfg.command, ...(cfg.args ?? []).map(quote)]
      : (cfg.args ?? []);

    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      // Third-party code: scoped environment (see mcp/env-scope.ts). Never
      // process.env — a marketplace server must not see the host's secrets.
      env: buildChildEnv(cfg, { label: this.server }).env,
      windowsHide: true,
      detached: false,
    });
    this.exited = false;
    this.spawnedAt = Date.now();
    // Track the PID, not just the handle: on Windows this child is a cmd.exe
    // shim that forks the real server, so a later kill must walk the tree.
    trackProcess(this.proc.pid, { server: this.server, command: cfg.command });

    // Spawn failures (command not found, permission denied) arrive as an
    // 'error' event — unhandled, it would crash the server process. Name the
    // failing command and give a per-runner install hint: "failed to start"
    // with no detail leaves the user staring at a dead connector (the exact
    // blender-style report).
    this.proc.on("error", (err: NodeJS.ErrnoException) => {
      this.exited = true;
      untrackProcess(this.proc?.pid);
      this.proc = null;
      const enoent = err.code === "ENOENT";
      // npx/uvx ride cmd.exe on Windows, so ENOENT here most often means the
      // RUNNER is missing — tell the user how to install that runner.
      const hint = enoent
        ? cfg.command === "uvx"
          ? ` — the "uvx" runner was not found: install uv first (pip install uv, or see https://docs.astral.sh/uv/), then retry`
          : cfg.command === "npx"
            ? ` — "npx" was not found: install Node.js (https://nodejs.org) so npx is on PATH, then retry`
            : ` — ENOENT: the command "${cfg.command}" is not installed or not on PATH`
        : `: ${err.message}`;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(
          new SdkError("MCP_SPAWN_FAILED", `MCP server "${this.server}" failed to start${hint}${enoent ? ` (launching: ${cfg.command})` : ""}`, {
            hint: enoent ? "install the runner, then reconnect" : "check the command and its arguments",
            cause: err,
          }),
        );
      }
      this.pending.clear();
    });

    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.error) p.reject(new Error(msg.error.message || "MCP error"));
            else p.resolve(msg.result);
          }
        } catch {
          // Non-JSON line (banner output) — ignore.
        }
      }
    });

    this.proc.stderr!.setEncoding("utf8");
    this.proc.stderr!.on("data", () => {
      /* servers log to stderr; swallowed (bounded by OS pipe) */
    });

    this.proc.on("exit", (code: number | null, signal: string | null) => {
      this.exited = true;
      untrackProcess(this.proc?.pid);
      this.proc = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(
          new SdkError("MCP_CRASHED", `MCP server "${this.server}" exited unexpectedly`, {
            hint: "the server will be respawned on the next call",
          }),
        );
      }
      this.pending.clear();
      if (this.closing) return;
      // Crash recovery: a marketplace server that dies on its own (OOM, bad
      // update, transient network for a remote-backed tool) used to stay dead
      // until the app restarted. Respawn with exponential backoff, bounded by
      // the host's policy, and give up with a line the host can log.
      this.scheduleRespawn(code, signal);
    });
  }

  /** Bounded exponential backoff; `mcpRespawn.maxAttempts: 1` disables it. */
  private scheduleRespawn(code: number | null, signal: string | null): void {
    const cfg = this.cfg;
    const policy = getAgentRuntimeConfig().mcpRespawn;
    const allowed = Math.max(1, policy.maxAttempts) - 1;
    if (!cfg || allowed <= 0) return;
    if (this.respawns >= allowed) {
      getAgentRuntimeConfig().logger.error("MCP server keeps crashing; giving up", {
        server: this.server,
        attempts: this.respawns,
        code,
        signal,
      });
      return;
    }
    this.respawns += 1;
    const delay = Math.min(policy.baseDelayMs * 2 ** (this.respawns - 1), policy.maxDelayMs);
    getAgentRuntimeConfig().logger.warn("MCP server exited; respawning", {
      server: this.server,
      attempt: this.respawns,
      of: allowed,
      delayMs: delay,
      code,
      signal,
    });
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      void this.ensureProc(cfg).catch((err: unknown) => {
        getAgentRuntimeConfig().logger.error("MCP respawn failed", {
          server: this.server,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, delay);
    // Never hold the host process open just to retry a dead connector.
    this.respawnTimer.unref?.();
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.proc || this.exited) {
      throw new SdkError("MCP_CRASHED", `MCP server "${this.server}" is not running`, { hint: "it is respawned on the next call" });
    }
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const timeoutMs = callTimeoutMs();
    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new SdkError("MCP_TIMEOUT", `MCP ${method} timed out after ${timeoutMs / 1000}s`, {
              hint: "the server did not answer; raise mcpToolTimeoutMs or reconnect it",
            }),
          );
        }, timeoutMs);
      }
      const clear = () => {
        if (timer) clearTimeout(timer);
      };
      this.pending.set(id, { resolve, reject, timer: timer as ReturnType<typeof setTimeout> });
      this.proc!.stdin!.write(msg + "\n", (err) => {
        if (err) {
          clear();
          this.pending.delete(id);
          reject(new SdkError("MCP_CRASHED", `MCP write failed: ${err.message}`, { hint: "the server process is gone; it respawns on the next call" }));
        }
      });
    });
  }

  async listTools(): Promise<McpToolDef[]> {
    if (this.tools) return this.tools;
    const result = (await this.rpc("tools/list", {})) as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> };
    // Reset the crash budget only for a child that has proven STABLE. Resetting
    // on every successful call would let a server that answers once and then
    // dies respawn forever — exactly the crash loop this budget exists to stop.
    if (Date.now() - this.spawnedAt > STABLE_MS) this.respawns = 0;
    this.tools = (result.tools ?? []).map((t) => ({
      server: this.server,
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema ?? {},
    }));
    return this.tools;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    // Local pre-flight (runtime-config.validateToolArgs): the server's own
    // rejection arrives late and in its own words, and the model retries
    // blind. Only tools we have a schema for are checked — a tool the model
    // learned about through mcp_search_tools is validated the same way once
    // tools/list has run, which getMcpServerForRun always does.
    if (getAgentRuntimeConfig().validateToolArgs && this.tools) {
      const known = this.tools.find((t) => t.name === toolName);
      if (known) {
        const check = validateToolArgs(known.inputSchema, args);
        if (!check.ok) {
          throw new SdkError("MCP_INVALID_ARGS", `MCP tool "${toolName}" got invalid arguments`, {
            hint: `fix these and retry: ${check.errors.slice(0, 5).join("; ")}`,
            details: { tool: toolName, errors: check.errors },
          });
        }
      }
    }
    const result = (await this.rpc("tools/call", { name: toolName, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    if (result?.isError) {
      const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
      throw new Error(text || "MCP tool error");
    }
    return (result?.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type} content]`))
      .join("\n")
      .slice(0, 30_000);
  }

  async shutdown(): Promise<void> {
    // Set first: the 'exit' handler must not treat our own kill as a crash and
    // schedule a respawn of the server we are shutting down.
    this.closing = true;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    const proc = this.proc;
    const pid = proc?.pid;
    this.proc = null;
    this.exited = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new SdkError("MCP_CRASHED", `MCP server "${this.server}" shut down`, { hint: "reconnect the server to use it again" }));
    }
    this.pending.clear();
    if (pid) {
      untrackProcess(pid);
      // Kill the tree, not just the shim: cmd.exe -> npx -> node must all go.
      await killTree(pid);
    } else if (proc) {
      try {
        proc.kill();
      } catch {}
    }
  }
}

// ── Session management ─────────────────────────────────────────────────────

/** Cached-session accessor. Fails honestly if the server isn't configured. */
async function getMcpServer(server: string): Promise<McpServerHandle> {
  const cached = sessions.get(server);
  if (cached) {
    if ((cached.handle as unknown as { alive?: boolean }).alive === false) {
      sessions.delete(server);
    } else {
      cached.lastUsed = Date.now();
      return cached.handle;
    }
  }
  const cfg = loadMcpConfig(process.cwd());
  const serverCfg = cfg[server];
  if (!serverCfg) {
    throw new Error(`MCP server "${server}" is not configured in orplex.config.json (mcpServers)`);
  }
  const handle = new StdioMcpServer(server);
  await (handle as unknown as { ensureProc(cfg: McpServerConfig): Promise<void> }).ensureProc(serverCfg);
  sessions.set(server, { handle, lastUsed: Date.now() });
  return handle;
}

// ── Per-run (account) sessions ─────────────────────────────────────────────

/** Sessions for account-connected servers are keyed by user + resolved
 *  config: two users never share a process even with byte-identical configs
 *  (the key previously omitted the principal, so no-secret servers like
 *  duckduckgo/fetch were shared cross-user), while the same user's identical
 *  config across runs IS reused. */
function accountSessionKey(server: string, cfg: McpServerConfig, userId: string): string {
  return `acct:${userId}:${server}:${createHash("sha1").update(JSON.stringify(cfg)).digest("hex").slice(0, 12)}`;
}

/**
 * Session accessor for run-supplied configs (user connectors merged with
 * workspace orplex.config.json). Fails honestly when the server is absent
 * from the supplied map — the executor always passes the run's merged map.
 */
export async function getMcpServerForRun(
  server: string,
  runConfigs: Record<string, McpServerConfig>,
  userId: string
): Promise<McpServerHandle> {
  const cfg = runConfigs[server];
  if (!cfg) {
    throw new Error(`MCP server "${server}" is not connected for this account (manage connectors in the app)`);
  }
  const key = accountSessionKey(server, cfg, userId);
  const cached = sessions.get(key);
  if (cached) {
    // A dead session (crashed child / failed probe) must not be reused.
    if ((cached.handle as unknown as { alive?: boolean }).alive === false) {
      sessions.delete(key);
    } else {
      cached.lastUsed = Date.now();
      return cached.handle;
    }
  }
  const handle = new StdioMcpServer(server);
  await (handle as unknown as { ensureProc(cfg: McpServerConfig): Promise<void> }).ensureProc(cfg);
  sessions.set(key, { handle, lastUsed: Date.now() });
  return handle;
}

// ── Idle reaping ───────────────────────────────────────────────────────────

let reapTimer: ReturnType<typeof setInterval> | null = null;

/** Called by the executor loop; reaps sessions idle for IDLE_REAP_MS. */
export function reapIdleMcpSessions(): void {
  const now = Date.now();
  for (const [name, session] of sessions) {
    if (now - session.lastUsed > IDLE_REAP_MS) {
      sessions.delete(name);
      void session.handle.shutdown();
    }
  }
  if (sessions.size === 0 && reapTimer) {
    clearInterval(reapTimer);
    reapTimer = null;
  }
}

/** Start the reaper only while sessions exist (no permanent timer handle). */
export function ensureMcpReaper(): void {
  if (!reapTimer) {
    reapTimer = setInterval(reapIdleMcpSessions, 60_000);
    // Never hold the event loop open just for reaping.
    (reapTimer as unknown as { unref?: () => void }).unref?.();
  }
}

/**
 * Shut down exactly one account session (probe cleanup). Other users' and
 * other servers' sessions are untouched. If a live run happens to share the
 * session, it respawns on next use (dead-session check in getMcpServerForRun)
 * and its in-flight calls fail fast via shutdown()'s pending rejection.
 */
export async function shutdownAccountSession(
  server: string,
  runConfigs: Record<string, McpServerConfig>,
  userId: string
): Promise<void> {
  const cfg = runConfigs[server];
  if (!cfg) return;
  const key = accountSessionKey(server, cfg, userId);
  const entry = sessions.get(key);
  if (!entry) return;
  sessions.delete(key);
  await entry.handle.shutdown().catch(() => {});
}

/** Kill everything (executor shutdown / tests). */
/**
 * Shut every MCP server down and reap anything still tracked.
 *
 * The host calls this once on quit (Electron `before-quit`). Session handles
 * normally kill their own trees; the registry sweep catches children whose
 * handle was lost — a crashed shim, a server that ignored SIGTERM, or a spawn
 * that died between `spawn()` and the first `exit` event.
 */
export async function shutdownAllMcp(): Promise<{ sessions: number; processes: number }> {
  const all = [...sessions.values()];
  sessions.clear();
  if (reapTimer) {
    clearInterval(reapTimer);
    reapTimer = null;
  }
  await Promise.all(all.map((s) => s.handle.shutdown().catch(() => {})));
  const processes = await shutdownAllSpawnedProcesses();
  return { sessions: all.length, processes };
}

/** Test seam: forget cached sessions without killing processes. */
export function resetMcpSessionsForTests(): void {
  sessions.clear();
}
