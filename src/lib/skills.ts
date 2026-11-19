/**
 * skills.ts — Worldwide AI coding skills (100+ skills)
 *
 * Sourced from: Claude Code marketplace, Cursor community,
 * awesome-agent-skills, Vercel, Trail of Bits, Remotion, and more.
 *
 * Each skill is a pre-built prompt template that gets injected
 * into the user's message when selected from the + menu.
 */

export interface Skill {
  id: string;
  name: string;
  icon: string;
  category: string;
  description: string;
  promptPrefix: string;
}

export interface SkillCategory {
  id: string;
  name: string;
  icon: string;
  skills: Skill[];
}

/**
 * Flatten categories into one list. Kept here because both the app and the
 * agent roster need the same order — the catalogue itself is marketplace data.
 */
export function flattenSkills(categories: readonly SkillCategory[]): Skill[] {
  return categories.flatMap((c) => c.skills);
}

/** Case-insensitive name/description/category search over a provided catalogue. */
export function searchSkills(query: string, categories: readonly SkillCategory[]): Skill[] {
  const lower = query.toLowerCase();
  return flattenSkills(categories).filter(
    (s) =>
      s.name.toLowerCase().includes(lower) ||
      s.description.toLowerCase().includes(lower) ||
      s.category.toLowerCase().includes(lower),
  );
}

/** Find one skill by id in a provided catalogue. */
export function getSkillById(id: string, categories: readonly SkillCategory[]): Skill | undefined {
  for (const cat of categories) {
    const hit = cat.skills.find((s) => s.id === id);
    if (hit) return hit;
  }
  return undefined;
}
