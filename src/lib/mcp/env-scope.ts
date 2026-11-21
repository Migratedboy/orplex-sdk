// env-scope.ts — which environment a spawned MCP server is allowed to see.
//
// A marketplace MCP server is third-party code launched through npx/uvx/cargo
// on the user's machine. In 0.3.x it received `{ ...process.env, ...cfg.env }`,
// i.e. the entire host environment — including NEXTAUTH_SECRET, DATABASE_URL and
// the session signing key. Nothing about the MCP protocol requires that: the
// server needs PATH to find its runtime, TEMP to write scratch files, and the
// credentials its own manifest declares. Everything else is the host's business.
//
// This module is the single place that decides. It is deliberately data-in /
// data-out so it can be unit-tested without spawning anything.

import { getAgentRuntimeConfig } from "../runtime-config";
import type { McpServerConfig } from "../mcp-client";

/**
 * OS-owned variables a child process needs to function. Not secrets: these name
 * directories and the interpreter search path, and a stdio server that cannot
 * find its runtime fails with a confusing ENOENT instead of a clear refusal.
 *
 * `NODE_OPTIONS` is deliberately absent (it can load arbitrary modules);
 * `npm_config_*` is handled by prefix below because npm shims need a few of them.
 */
export const MCP_ENV_BASELINE: readonly string[] = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "COMSPEC",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
];

/** Prefixes forwarded in "manifest" mode (package managers need their own). */
const BASELINE_PREFIXES: readonly string[] = ["npm_config_", "NPM_CONFIG_", "UV_", "XDG_"];

/**
 * Names that never leave the host, whatever the allowlist says.
 *
 * Deliberately name-shaped, not value-shaped: the host cannot know which of its
 * variables hold credentials, but their names give it away (…_TOKEN, …_SECRET,
 * …_API_KEY, …_PASSWORD). `SEQ`/`SESSION` catch the session-signing material the
 * app keeps next to secrets it does recognise.
 */
const NEVER_FORWARD: readonly RegExp[] = [
  /(^|_)(SECRET|SECRETS|PASSWORD|PASSWD|PASS|PRIVATE_?KEY|PUBLIC_?KEY|API_?KEY|APIKEY|TOKEN|JWKS?|SESSION|COOKIE|CREDENTIALS?|DSN)(_|$)/i,
  /^DATABASE_URL$/i,
  /^ORPLEX_/i,
  /^NEXTAUTH_/i,
  /^(AWS|AZURE|GCP|GOOGLE|OPENAI|ANTHROPIC|GROQ|NVIDIA|SUPABASE|VERCEL|SENTRY|STRIPE|GITHUB|GITLAB|RESEND|CLERK)_/i,
  /^GOOGLE_APPLICATION_CREDENTIALS$/i,
];

const warned = new Set<string>();

function forwardable(name: string): boolean {
  return !NEVER_FORWARD.some((re) => re.test(name));
}

export interface BuildChildEnvResult {
  env: Record<string, string>;
  /** Host variables withheld from the child (names only — never values). */
  dropped: string[];
}

/**
 * The environment for one MCP child process.
 *
 * "inherit" keeps the 0.3.x passthrough for hosts that opted in; even then the
 * never-forward list is honoured, because a leaked session key is not a
 * behavioural preference.
 */
export function buildChildEnv(
  cfg: Pick<McpServerConfig, "env" | "declaredEnv">,
  options: { hostEnv?: NodeJS.ProcessEnv; mode?: "manifest" | "inherit"; allowlist?: string[]; label?: string } = {},
): BuildChildEnvResult {
  const runtime = getAgentRuntimeConfig();
  const hostEnv = options.hostEnv ?? process.env;
  const mode = options.mode ?? runtime.mcpEnv.mode;
  const allowlist = options.allowlist ?? runtime.mcpEnv.allowlist;
  const env: Record<string, string> = {};
  const dropped: string[] = [];

  const keep = (name: string) => {
    const value = hostEnv[name];
    if (typeof value !== "string") return;
    if (!forwardable(name)) {
      dropped.push(name);
      return;
    }
    env[name] = value;
  };

  if (mode === "inherit") {
    for (const name of Object.keys(hostEnv)) keep(name);
  } else {
    for (const name of MCP_ENV_BASELINE) keep(name);
    for (const name of Object.keys(hostEnv)) {
      if (!BASELINE_PREFIXES.some((p) => name.startsWith(p))) continue;
      if (name in env) continue;
      keep(name);
    }
    for (const name of allowlist) if (!(name in env)) keep(name);
  }

  // The manifest's own variables always win — they are the reason this child
  // exists, and the host has already decrypted them for this server only.
  for (const [name, value] of Object.entries(cfg.env ?? {})) {
    if (typeof value !== "string") continue;
    env[name] = value;
  }

  // A declaredEnv list is the manifest's statement of what this server may
  // receive. Undeclared extras are a host wiring bug: warn once, keep them
  // (dropping them would break a working connector mid-run with no explanation).
  if (cfg.declaredEnv?.length) {
    const declared = new Set(cfg.declaredEnv);
    const undeclared = Object.keys(cfg.env ?? {}).filter((n) => !declared.has(n) && n in env);
    if (undeclared.length && !warned.has(`undeclared:${options.label ?? ""}`)) {
      warned.add(`undeclared:${options.label ?? ""}`);
      runtime.logger.warn("MCP server received env vars its manifest does not declare", {
        server: options.label ?? "(unnamed)",
        names: undeclared,
      });
    }
  }

  if (dropped.length && !warned.has(`dropped:${options.label ?? ""}`)) {
    warned.add(`dropped:${options.label ?? ""}`);
    runtime.logger.info("MCP child environment scoped", {
      server: options.label ?? "(unnamed)",
      mode,
      forwarded: Object.keys(env).length,
      withheld: dropped.length,
    });
  }

  return { env, dropped };
}

/** Test seam: forget which warnings were already emitted. */
export function resetEnvScopeWarnings(): void {
  warned.clear();
}
