// plugin-library-state.ts — Per-workspace state for installed LIBRARY bundles.
//
// File: <workspace>/.orplex/bundles.json
//   { "verified-commits": { "enabled": true, "installedAt": "...",
//                           "rules": { "deny": [...], "notify": [...] } } }
//
// Why this file exists: installPlugin() merges hook RULES into
// .orplex/hooks.json, but that file's parser (user-hooks.ts) only understands
// process-command hooks — regex deny/notify rules written there are inert.
// Library bundles therefore carry their deny/notify rules HERE, and
// loadToolHooks() (the enforced per-tool-call gate) merges the enabled ones.
// Toggling flips one JSON field — the skill files stay on disk.
//
// Rules are snapshotted at install time so enforcement reflects what the user
// agreed to when clicking Install, not whatever the current app version ships.
// A missing entry for an installed bundle falls back to the current catalog
// rules and defaults to enabled (legacy installs keep working).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isBundleInstalled } from "./plugin-library";
import type { LibraryBundle } from "./plugin-library/types";

const STATE_FILE = "bundles.json";

/**
 * Where the library bundles come from.
 *
 * They are marketplace data, so the SDK cannot know them — but the hook gate
 * (`loadToolHooks` → `loadEnabledBundleRules`) runs deep inside tool dispatch
 * and has no caller to take them from. The host registers a provider once:
 *
 *   configureLibraryBundles(async () => materializeBundles(await getPluginBundles()))
 *
 * Unconfigured, there are no library bundles and no library rules — fail closed,
 * same policy as the approval store.
 */
type BundleProvider = () => readonly LibraryBundle[] | Promise<readonly LibraryBundle[]>;
let bundleProvider: BundleProvider = () => [];

export function configureLibraryBundles(provider: BundleProvider): void {
  bundleProvider = provider;
}

async function currentBundles(): Promise<readonly LibraryBundle[]> {
  try {
    return await bundleProvider();
  } catch {
    // A catalogue outage must not break the hook gate — no bundles, no rules.
    return [];
  }
}

export interface BundleStateEntry {
  enabled: boolean;
  installedAt?: string;
  rules?: { deny: string[]; notify: string[] };
}

export type BundleState = Record<string, BundleStateEntry>;

/** Raw deny/notify rules for a catalog slug, or null. */
function catalogRules(bundles: readonly LibraryBundle[], slug: string): { deny: string[]; notify: string[] } | null {
  const entry = bundles.find((b) => b.slug === slug);
  if (!entry?.bundle.hooks || typeof entry.bundle.hooks !== "object") return null;
  const hooks = entry.bundle.hooks as { deny?: unknown; notify?: unknown };
  return {
    deny: Array.isArray(hooks.deny) ? (hooks.deny as string[]) : [],
    notify: Array.isArray(hooks.notify) ? (hooks.notify as string[]) : [],
  };
}

/** Read the raw state file. Never throws — unreadable means empty state. */
export async function readBundleState(workspaceRoot: string): Promise<BundleState> {
  try {
    const raw = await readFile(join(workspaceRoot, ".orplex", STATE_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as BundleState;
    }
    return {};
  } catch {
    return {};
  }
}

async function writeBundleState(workspaceRoot: string, state: BundleState): Promise<void> {
  const orplexDir = join(workspaceRoot, ".orplex");
  await mkdir(orplexDir, { recursive: true });
  await writeFile(join(orplexDir, STATE_FILE), JSON.stringify(state, null, 2), "utf8");
}

/**
 * Record an install: enabled by default, rules snapshotted from the catalog.
 * Called by the install route; idempotent (reinstall refreshes the snapshot).
 */
export async function recordBundleInstall(
  bundles: readonly LibraryBundle[],
  workspaceRoot: string,
  slug: string,
): Promise<void> {
  const state = await readBundleState(workspaceRoot);
  state[slug] = {
    enabled: true,
    installedAt: new Date().toISOString(),
    ...(catalogRules(bundles, slug) ? { rules: catalogRules(bundles, slug)! } : {}),
  };
  await writeBundleState(workspaceRoot, state);
}

/**
 * Flip a bundle's enabled flag. The bundle must be a known library slug;
 * the skill files are never touched. Returns the new state or null if the
 * slug is unknown.
 */
export async function setBundleEnabled(
  bundles: readonly LibraryBundle[],
  workspaceRoot: string,
  slug: string,
  enabled: boolean,
): Promise<BundleStateEntry | null> {
  if (!bundles.some((b) => b.slug === slug)) return null;
  const state = await readBundleState(workspaceRoot);
  const existing = state[slug];
  state[slug] = {
    enabled,
    ...(existing?.installedAt ? { installedAt: existing.installedAt } : {}),
    ...(existing?.rules ?? (catalogRules(bundles, slug) ? { rules: catalogRules(bundles, slug)! } : {})),
  };
  await writeBundleState(workspaceRoot, state);
  return state[slug];
}

/** Enabled flag for display: installed + no entry → true (default on). */
export async function isBundleEnabled(workspaceRoot: string, slug: string): Promise<boolean> {
  const state = await readBundleState(workspaceRoot);
  return state[slug]?.enabled !== false;
}

export interface EnabledBundleRules {
  deny: string[];
  notify: string[];
  /** Slugs whose rules were merged (for diagnostics). */
  active: string[];
}

/**
 * Rules the enforcement gate should apply: every bundle that is physically
 * installed (first skill present) and not explicitly disabled. Called from
 * loadToolHooks — must never throw and must stay cheap (a handful of stats
 * + one small file read, cached upstream for 60s).
 */
export async function loadEnabledBundleRules(
  workspaceRoot: string,
  bundles?: readonly LibraryBundle[],
): Promise<EnabledBundleRules> {
  const catalog = bundles ?? (await currentBundles());
  const out: EnabledBundleRules = { deny: [], notify: [], active: [] };
  let state: BundleState = {};
  try {
    state = await readBundleState(workspaceRoot);
  } catch {
    return out;
  }
  for (const bundle of catalog) {
    if (state[bundle.slug]?.enabled === false) continue; // explicit off
    let installed = false;
    try {
      installed = await isBundleInstalled(catalog, workspaceRoot, bundle.slug);
    } catch {
      installed = false;
    }
    if (!installed) continue;
    const rules = state[bundle.slug]?.rules ?? catalogRules(catalog, bundle.slug);
    if (!rules) continue;
    out.deny.push(...rules.deny);
    out.notify.push(...rules.notify);
    out.active.push(bundle.slug);
  }
  return out;
}

