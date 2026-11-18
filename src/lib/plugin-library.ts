// plugin-library.ts — Built-in plugin bundle library: the public surface.
// Bundle definitions live in plugin-library/ (one file per category); this
// module materializes them into installable units for the SAME installPlugin()
// path workspace bundles use (existing user files always win). A bundle is
// "installed" when its first skill exists in the workspace — content-based,
// so a bundle installed by hand still shows green.

import { access } from "node:fs/promises";
import { join } from "node:path";
import type { ParsedPlugin } from "./plugin-bundles";
import { QUALITY_BUNDLES } from "./plugin-library/quality";
import { SECURITY_BUNDLES } from "./plugin-library/security";
import { DEVOPS_BUNDLES } from "./plugin-library/devops";
import { INTELLIGENCE_BUNDLES } from "./plugin-library/intelligence";
import type { BundleDef, LibraryBundle, PluginCategory } from "./plugin-library/types";

export type { PluginCategory } from "./plugin-library/types";

/** All built-in bundles, in category order (quality → intelligence). */
export const BUILTIN_BUNDLES: LibraryBundle[] = [
  ...QUALITY_BUNDLES,
  ...SECURITY_BUNDLES,
  ...DEVOPS_BUNDLES,
  ...([] as BundleDef[]),
  ...INTELLIGENCE_BUNDLES,
].map(materialize);

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

/** Materialize a library slug, or null if unknown. */
export function materializeBundle(slug: string): ParsedPlugin | null {
  const entry = BUILTIN_BUNDLES.find((b) => b.slug === slug);
  return entry ? entry.bundle : null;
}

/**
 * Is this bundle already installed in the workspace? Content-based: the
 * bundle's first skill existing under .orplex/skills/ means yes.
 */
export async function isBundleInstalled(workspaceRoot: string, slug: string): Promise<boolean> {
  const entry = BUILTIN_BUNDLES.find((b) => b.slug === slug);
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
export function listLibrary(): Array<{
  slug: string;
  name: string;
  category: PluginCategory;
  version: string;
  description: string;
  skillCount: number;
  hasHooks: boolean;
  hasMcp: boolean;
}> {
  return BUILTIN_BUNDLES.map((b) => ({
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
