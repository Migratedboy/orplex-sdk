// mcp-catalog.ts — Orplex's verified catalog of MCP (Model Context Protocol)
// servers, surfaced in the Connectors UI ("+" → MCP servers).
//
// Entry shape (spec §Phase 1): auth hint + optional remote (OAuth) + nested
// stdio {command, args, env:[{name,label,secret,required,help}]} + optional
// oauth hints. Entries may carry BOTH remote(oauth) and stdio(token); the UI
// defaults to remote/OAuth when present. Saved McpServerConfig rows keep the
// flat command/args/env wire shape, so existing connections keep working.
//
// A note on honesty: the MCP ecosystem moves fast — command strings below are
// verified against each project's README at time of writing, but npm/PyPI
// package names drift. The Connectors panel runs a real `listTools` probe
// (test-connection) before a server is marked healthy, so a stale template
// fails loudly at connect time instead of silently at run time. Remote URLs
// are NEVER trusted from this file: Phase 6 (scripts/audit-mcp-catalog.mjs)
// probes each candidate and only verified endpoints ship as `remote`.

import { z } from "zod";

const MCP_CATEGORY_KEYS = [
  "database",
  "devtools",
  "cloud",
  "design",
  "productivity",
  "data",
  "ai",
  "payments",
  "comms",
  "web",
  "search",
  "files",
  "shell",
] as const;

export type McpCategory = (typeof MCP_CATEGORY_KEYS)[number];

/** How a connector authenticates to its server. */
export type McpAuthType = "oauth" | "token" | "none";

/**
 * Builder input for env declarations (kept in the legacy key/description
 * spelling so entry call-sites stay terse — entry() converts it to stdio.env).
 */
export interface McpEnvSpec {
  key: string;
  description: string;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
}

/** One declared env var for the stdio launch (spec shape). */
export interface McpStdioEnv {
  name: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  help?: string;
}

export interface McpStdioSpec {
  command: string;
  args: string[];
  env: McpStdioEnv[];
}

export interface McpRemoteSpec {
  url: string;
  transport: "streamable-http" | "sse";
}

export interface McpOAuthSpec {
  scopes?: string[];
  /**
   * Pinned authorization-server issuer for servers that do NOT advertise
   * resource metadata on their 401 (RFC 9728): the SDK seeds its discovery
   * from the provider's discoveryState, so OAuth bootstrap (DCR → authorize)
   * still works. Only set for vendors whose AS identity is documented and
   * stable (auth.atlassian.com, login.microsoftonline.com/…).
   */
  authority?: string;
  /** Only for providers without dynamic registration (filled from the Phase 6 audit). */
  clientId?: string;
  /** Confidential clients need the secret — see the env-injection block below. */
  clientSecret?: string;
  /**
   * Client-ID Metadata Document (CIMD): the AS advertises
   * client_id_metadata_document_supported and the SDK uses our
   * clientMetadataUrl as the client_id, skipping registration entirely.
   * Only set when the AS actually supports CIMD (probe-verified).
   */
  cimd?: boolean;
}

export interface McpCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: McpCategory;
  popular?: boolean;
  auth: McpAuthType;
  /** Primary path when present — the UI defaults to remote/OAuth. */
  remote?: McpRemoteSpec;
  /** Local process path (also the token fallback for hybrid entries). */
  stdio?: McpStdioSpec;
  oauth?: McpOAuthSpec;
  docsUrl?: string;
}

// ── Zod validation (runs at load — see validateMcpCatalog) ──────────────────

const LOOPBACK_HTTP = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i;

const stdioEnvSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  label: z.string().min(1),
  secret: z.boolean().optional(),
  required: z.boolean().optional(),
  help: z.string().optional(),
});

export const mcpCatalogEntrySchema = z
  .object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  description: z.string().min(11),
  category: z.enum(MCP_CATEGORY_KEYS),
  popular: z.boolean().optional(),
  auth: z.enum(["oauth", "token", "none"]),
  remote: z
    .object({
      url: z
        .string()
        .url()
        .refine((u) => u.startsWith("https://") || LOOPBACK_HTTP.test(u), "remote URL must be https (http allowed on loopback only)"),
      transport: z.enum(["streamable-http", "sse"]),
    })
    .optional(),
  stdio: z
    .object({
      command: z.string().min(1),
      args: z.array(z.string()),
      env: z.array(stdioEnvSchema).superRefine((env, ctx) => {
        const seen = new Set<string>();
        for (const v of env) {
          if (seen.has(v.name)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate env var ${v.name}` });
          }
          seen.add(v.name);
        }
      }),
    })
    .optional(),
  oauth: z
    .object({
      scopes: z.array(z.string()).min(1).optional(),
      clientId: z.string().min(1).optional(),
      clientSecret: z.string().min(1).optional(),
      authority: z.string().url().optional(),
      cimd: z.boolean().optional(),
    })
    .optional(),
  docsUrl: z
    .string()
    .url()
    .optional()
    .refine((u) => u === undefined || u.startsWith("https://"), "docsUrl must be https"),
  })
  // An entry with neither transport cannot be connected to, so it is not a
  // catalogue entry — it is a row the UI would render and then fail on. Reject
  // it at validation time rather than at connect time.
  .superRefine((e, ctx) => {
    if (!e.stdio && !e.remote) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stdio"],
        message: "entry needs a transport: stdio or remote",
      });
    }
  });

export interface McpCatalogValidation {
  ok: boolean;
  errors: string[];
}

export function validateMcpCatalog(catalog: readonly McpCatalogEntry[]): McpCatalogValidation {
  const parsed = z.array(mcpCatalogEntrySchema).safeParse(catalog);
  if (parsed.success) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

const npx = (pkg: string, ...rest: string[]): { command: string; args: string[] } => ({
  command: "npx",
  args: ["-y", pkg, ...rest],
});

const uvx = (pkg: string, ...rest: string[]): { command: string; args: string[] } => ({
  command: "uvx",
  args: [pkg, ...rest],
});

const entry = (
  id: string,
  name: string,
  description: string,
  category: McpCategory,
  cmd: { command: string; args: string[] },
  envSpec: McpEnvSpec[] = [],
  opts: { docsUrl?: string; popular?: boolean; auth?: McpAuthType; remote?: McpRemoteSpec; oauth?: McpOAuthSpec } = {}
): McpCatalogEntry => ({
  id,
  name,
  description,
  category,
  popular: opts.popular,
  // Explicit opt wins; oauth hint implies oauth; any declared secret means
  // token auth; otherwise the server needs no credentials.
  auth: opts.auth ?? (opts.oauth ? "oauth" : envSpec.some((s) => s.secret) ? "token" : "none"),
  ...(opts.remote ? { remote: opts.remote } : {}),
  ...(opts.oauth ? { oauth: opts.oauth } : {}),
  stdio: {
    command: cmd.command,
    args: cmd.args,
    env: envSpec.map((s) => ({
      name: s.key,
      label: s.description,
      ...(s.secret !== undefined ? { secret: s.secret } : {}),
      ...(s.required !== undefined ? { required: s.required } : {}),
      ...(s.placeholder !== undefined ? { help: s.placeholder } : {}),
    })),
  },
  ...(opts.docsUrl ? { docsUrl: opts.docsUrl } : {}),
});

const URL_ENV = (key = "URL", description = "Server URL (https://…)"): McpEnvSpec => ({
  key,
  description,
  required: true,
  placeholder: "https://",
});

const KEY_ENV = (key: string, description: string, placeholder?: string): McpEnvSpec => ({
  key,
  description,
  required: true,
  secret: true,
  placeholder,
});

/** Plain (non-secret) env value — stored and displayed as-is. */
const PLAIN_ENV = (key: string, description: string, placeholder?: string, required = false): McpEnvSpec => ({
  key,
  description,
  required,
  placeholder,
});

// ── The catalog ─────────────────────────────────────────────────────────────


// ── Static OAuth clients from the environment ──────────────────────────────
// Proportionalized 2026-11 probe: several hosted connectors' authorization
// servers do NOT support dynamic client registration (DCR) — Slack, Render,
// ElevenLabs, Microsoft Graph, and any vendor an operator pins. The SDK's
// silent sign-in dies there and the browser leg never opens, which is EXACTLY
// the "this connector doesn't work" report class. Those providers work the
// moment the operator registers ONE app with the vendor and injects here:
//   ORPLEX_MCP_CLIENT_ID_<ID>            (confidential clients also:)
//   ORPLEX_MCP_CLIENT_SECRET_<ID>
// (id dashed→uppercase-underscored: SLACK, GOOGLE_DRIVE, ONE_DRIVE, …).
// An env value overrides whatever the catalog entry carries.

const envClientKey = (
  id: string,
  kind: "CLIENT_ID" | "CLIENT_SECRET",
  env: Record<string, string | undefined>,
): string | undefined => {
  const key = `ORPLEX_MCP_${kind}_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const raw = env[key];
  return raw && raw.trim() ? raw.trim() : undefined;
};


/**
 * Apply per-deployment OAuth client credentials to catalogue entries.
 *
 * The catalogue itself ships from the marketplace, so an operator override has
 * to be applied to whatever was fetched — `ORPLEX_MCP_CLIENT_ID_<ID>` /
 * `ORPLEX_MCP_CLIENT_SECRET_<ID>` (id upper-cased, non-alphanumerics to _).
 * Returns new objects; the input is not mutated.
 */
export function applyOAuthEnvOverrides(
  catalog: readonly McpCatalogEntry[],
  env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env,
): McpCatalogEntry[] {
  return catalog.map((entry) => {
    const clientId = envClientKey(entry.id, "CLIENT_ID", env);
    const clientSecret = envClientKey(entry.id, "CLIENT_SECRET", env);
    if (!clientId && !clientSecret) return entry;
    return { ...entry, oauth: { ...(entry.oauth ?? {}), ...(clientId ? { clientId } : {}), ...(clientSecret ? { clientSecret } : {}) } };
  });
}

/** All categories in display order with labels. */
export const MCP_CATEGORIES: Array<{ key: McpCategory | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "database", label: "Databases" },
  { key: "devtools", label: "Dev tools" },
  { key: "cloud", label: "Cloud" },
  { key: "design", label: "Design" },
  { key: "productivity", label: "Productivity" },
  { key: "data", label: "Data" },
  { key: "search", label: "Search" },
  { key: "ai", label: "AI" },
  { key: "payments", label: "Payments" },
  { key: "comms", label: "Comms" },
  { key: "files", label: "Files" },
  { key: "shell", label: "Shell" },
  { key: "web", label: "Web" },
];

/**
 * Look an entry up by id. The catalogue is a parameter, not module state: the
 * entries come from the signed marketplace bundle, so a lookup must never
 * assume this module knows them.
 */
export function getMcpCatalogEntry(id: string, catalog: readonly McpCatalogEntry[]): McpCatalogEntry | null {
  return catalog.find((e) => e.id === id) ?? null;
}

/**
 * Search the catalog: name/id/description match, optional category filter.
 * Name and id hits rank above description hits; popular entries rank above
 * the rest inside a tie. Pure function — unit-tested.
 */
export function searchMcpCatalog(
  query: string,
  category: McpCategory | "all",
  limit: number,
  catalog: readonly McpCatalogEntry[],
): McpCatalogEntry[] {
  // Normalize hyphens/underscores to spaces on both sides so "knowledge
  // graph" finds "Knowledge-graph" and "brave_search" finds "brave search".
  const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, " ");
  const q = norm(query.trim());
  const pool = category === "all" ? catalog : catalog.filter((e) => e.category === category);
  const score = (e: McpCatalogEntry): number => {
    if (!q) return e.popular ? 2 : 1;
    const name = norm(e.name);
    const id = norm(e.id);
    if (name === q || id === q) return 100;
    if (name.startsWith(q) || id.startsWith(q)) return 80;
    if (name.includes(q) || id.includes(q)) return 60;
    if (norm(e.description).includes(q)) return 40;
    if (e.category.includes(q)) return 20;
    return 0;
  };
  return pool
    .map((e) => ({ e, s: score(e) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s || (a.e.popular ? -1 : 1))
    .slice(0, limit)
    .map(({ e }) => e);
}

