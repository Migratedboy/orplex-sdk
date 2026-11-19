// plugin-library.ts — Plugin bundle library: materialization and lookups.
//
// The bundle DEFINITIONS are marketplace data (signed, fetched by the host) —
// this module only materializes them into installable units for the SAME installPlugin()
// path workspace bundles use (existing user files always win). A bundle is
// "installed" when its first skill exists in the workspace — content-based,
// so a bundle installed by hand still shows green.

import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedPlugin } from "./plugin-bundles";
import type { BundleDef, LibraryBundle, PluginCategory } from "./plugin-library/types";

export type { PluginCategory, BundleDef, LibraryBundle } from "./plugin-library/types";


/** One-line value safe for the tiny `key: value` frontmatter parser. */
function oneLine(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * The blurb is the first prose line after the `# Title` — that is the sentence
 * written for a human choosing the skill, so it is the best roster line.
 */
function blurbOf(body: string): string {
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line && !line.startsWith("#") && line !== "---") return oneLine(line, 120);
  }
  return "";
}

/**
 * Library SKILL.md bodies are authored as `# Title` + rules, with no
 * frontmatter. Copied verbatim, every installed skill reached the agent
 * roster as `name: (no description)` — 32 identically blank lines the model
 * could not choose between. Install the file WITH frontmatter instead.
 */
function withFrontmatter(skill: { name: string; body: string }, bundleDescription: string): string {
  if (/^\uFEFF?---\r?\n/.test(skill.body)) return skill.body;
  const description = blurbOf(skill.body) || oneLine(bundleDescription, 120);
  return `---\nname: ${oneLine(skill.name, 48)}\ndescription: ${description}\n---\n\n${skill.body.replace(/^\uFEFF/, "")}`;
}

function materialize(def: BundleDef): LibraryBundle {
  return {
    slug: def.slug,
    category: def.category,
    version: def.version,
    description: def.description,
    bundle: {
      manifest: { name: def.slug, version: def.version, description: def.description },
      rootDir: `builtin:${def.slug}`,
      skills: def.skills.map((s) => ({ name: s.name, body: withFrontmatter(s, def.description) })),
      hooks: (def.hooks ?? undefined) as unknown,
      mcp: (def.mcp ?? undefined) as unknown,
      warnings: [],
    },
  };
}

/**
 * Turn marketplace bundle data into installable units. Call this once on the
 * verified catalogue — materializing builds each bundle's SKILL.md text.
 */
export function materializeBundles(defs: readonly BundleDef[]): LibraryBundle[] {
  return defs.map((def) => materialize(def));
}

/** Materialize a library slug, or null if unknown. */
export function materializeBundle(bundles: readonly LibraryBundle[], slug: string): ParsedPlugin | null {
  const entry = bundles.find((b) => b.slug === slug);
  return entry ? entry.bundle : null;
}

/**
 * Is this bundle already installed in the workspace? Content-based: the
 * bundle's first skill existing under .orplex/skills/ means yes.
 */
export async function isBundleInstalled(
  bundles: readonly LibraryBundle[],
  workspaceRoot: string,
  slug: string,
): Promise<boolean> {
  const entry = bundles.find((b) => b.slug === slug);
  if (!entry || entry.bundle.skills.length === 0) return false;
  const first = entry.bundle.skills[0].name.replace(/[^\w.-]/g, "_").slice(0, 64);
  try {
    await access(join(workspaceRoot, ".orplex", "skills", first, "SKILL.md"));
    return true;
  } catch {
    return false;
  }
}

/** Library listing for the API/UI (no fs access needed for the catalog itself). */
export function listLibrary(bundles: readonly LibraryBundle[]): Array<{
  slug: string;
  name: string;
  category: PluginCategory;
  version: string;
  description: string;
  skillCount: number;
  hasHooks: boolean;
  hasMcp: boolean;
}> {
  return bundles.map((b) => ({
    slug: b.slug,
    name: b.slug,
    category: b.category,
    version: b.version,
    description: b.description,
    skillCount: b.bundle.skills.length,
    hasHooks: b.bundle.hooks !== undefined,
    hasMcp: b.bundle.mcp !== undefined,
  }));
}
