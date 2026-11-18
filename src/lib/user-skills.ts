// user-skills.ts — User-authored SKILL.md discovery (.orplex/skills/<name>/).
//
// Complements the built-in catalog in skills.ts (SKILL_CATEGORIES, used by
// the chat UI's skills menu). This module discovers USER-DEFINED skills:
//
//   <root>/.orplex/skills/<name>/SKILL.md    — project skills
//   ~/.orplex/skills/<name>/SKILL.md         — user-level skills
//
// The agent's system prompt carries only a NAME + DESCRIPTION roster; the
// agent pulls a full body on demand via the `use_skill` tool. Frontmatter is a
// deliberately tiny YAML subset (key: value lines between --- fences), parsed
// with zero dependencies.

import { readdir } from "fs/promises";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// 64, not 32: the built-in plugin library alone ships 40 skills, so installing
// the library used to leave 8 of them on disk and unreachable. The roster is
// capped by CHARACTERS (MAX_ROSTER_CHARS), which is the real prompt budget, and
// it still keeps every name.
export const MAX_SKILLS = 64;
export const MAX_DESCRIPTION_CHARS = 120;
export const MAX_ROSTER_CHARS = 1_600;
export const MAX_SKILL_BODY_CHARS = 12_000;

export interface UserSkill {
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
  /** "project/<name>" or "user/<name>" — provenance for debugging. */
  source: string;
}

/**
 * Strip one layer of matching quotes. `description: "Ship it"` is how most
 * people (and every YAML formatter) write frontmatter, and keeping the quotes
 * made the NAME unmatchable: the roster advertised `- "deploy": …` while a
 * `use_skill(name_of_skill: "deploy")` call found nothing.
 */
function unquote(value: string): string {
  const t = value.trim();
  if (t.length >= 2) {
    const q = t[0];
    if ((q === '"' || q === "'" || q === "`") && t[t.length - 1] === q) {
      return t.slice(1, -1).trim();
    }
  }
  return t;
}

/** Skill names are matched case- and whitespace-insensitively. */
export function normalizeSkillName(name: string): string {
  return unquote(String(name ?? "")).replace(/\s+/g, " ").trim().toLowerCase();
}

/** Minimal YAML-subset frontmatter parser (key: value lines). Zero deps. */
export function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const data: Record<string, string> = {};
  // A UTF-8 BOM (Notepad, many Windows editors) used to defeat the `^---`
  // anchor entirely: the header became body text and the skill lost its name
  // and description.
  const text = String(raw ?? "").replace(/^\uFEFF/, "");
  // Opening fence, then the optional YAML block, then the closing fence.
  // The block is OPTIONAL so a file that opens and closes the fence with
  // nothing between them (`---\n---\n`) parses as empty frontmatter; the old
  // regex required a newline before the closing fence, so those files kept
  // their `---` lines as body text and lost their name.
  const fence = text.match(/^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*\r?\n?/);
  if (!fence) return { data, body: text.trim() };
  for (const line of (fence[1] ?? "").split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) data[kv[1].toLowerCase()] = unquote(kv[2]);
  }
  return { data, body: text.slice(fence[0].length).trim() };
}

/**
 * Locate a skill's instruction file. `SKILL.md` is the documented name, but
 * filesystems differ: Windows/macOS treat `skill.md` as the same file while
 * Linux does not — and a Windows-authored, git-committed skill can therefore
 * be named `skill.md` and vanish on a Linux host. Match the name
 * case-insensitively rather than silently dropping the skill.
 */
function resolveSkillFile(dirPath: string): string | null {
  const exact = join(dirPath, "SKILL.md");
  if (existsSync(exact)) return exact;
  try {
    const hit = readdirSync(dirPath).find((f) => f.toLowerCase() === "skill.md");
    return hit ? join(dirPath, hit) : null;
  } catch {
    return null;
  }
}

/** Directory, or a symlink that points at one (shared/linked skill dirs). */
function isSkillDir(dirPath: string, entry: { name: string; isDirectory(): boolean; isSymbolicLink?(): boolean }): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink?.()) return false;
  try {
    return statSync(join(dirPath, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function toSkill(abs: string, source: string): UserSkill | null {
  try {
    if (!existsSync(abs)) return null;
    const raw = readFileSync(abs, "utf8");
    if (!raw.replace(/^\uFEFF/, "").trim()) return null;
    const { data, body } = parseFrontmatter(raw);
    const fallbackName = source.split("/").pop() || "skill";
    const name = (data.name || fallbackName).replace(/\s+/g, " ").trim().slice(0, 48) || fallbackName;
    return {
      name,
      description: (data.description || "").slice(0, MAX_DESCRIPTION_CHARS),
      whenToUse: data["when-to-use"] ? data["when-to-use"].slice(0, MAX_DESCRIPTION_CHARS) : undefined,
      body: body.slice(0, MAX_SKILL_BODY_CHARS),
      source,
    };
  } catch {
    return null;
  }
}

/**
 * Discover user skills for a workspace root (project + user level). Never
 * throws. `userHome` is injectable because os.homedir() is cached by Node and
 * cannot be redirected (or spied on) from a test.
 */
export async function loadUserSkills(rootDir: string, userHome: string = homedir()): Promise<UserSkill[]> {
  const out: UserSkill[] = [];
  const seen = new Set<string>();

  const dirs: Array<[string, string]> = [
    [join(rootDir, ".orplex", "skills"), "project"],
    [join(userHome, ".orplex", "skills"), "user"],
  ];
  for (const [dir, level] of dirs) {
    let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink?(): boolean }> = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Deterministic roster order: readdir's order is filesystem-dependent, so
    // which skills survived a tight roster budget used to vary per machine.
    entries = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (!isSkillDir(dir, e)) continue;
      if (out.length >= MAX_SKILLS) break;
      const skillPath = resolveSkillFile(join(dir, e.name));
      // A directory without any SKILL.md is not a skill (asset folders live
      // next to skills); skip it without consuming the cap.
      if (!skillPath) continue;
      const skill = toSkill(skillPath, `${level}/${e.name}`);
      const key = normalizeSkillName(skill?.name ?? "");
      if (skill && key && !seen.has(key)) {
        seen.add(key);
        out.push(skill);
      }
    }
  }
  return out;
}

/**
 * Roster for the system prompt: name + description, hard-capped at
 * MAX_ROSTER_CHARS. Every discovered skill keeps at least its NAME: the old
 * implementation broke out of the loop when the budget ran out, so with
 * long descriptions only ~12 of 32 loaded skills were advertised and the
 * agent could never call the rest.
 */
export function renderSkillRoster(skills: UserSkill[]): string {
  if (skills.length === 0) return "";
  const lines: string[] = [];
  let remaining = MAX_ROSTER_CHARS;
  for (let i = 0; i < skills.length; i++) {
    const s = skills[i];
    const left = skills.length - i;
    const head = `- ${s.name}: `;
    // Fair share of what's left, so one long description cannot starve the
    // skills that follow it.
    const share = Math.max(head.length, Math.floor(remaining / left));
    // `when-to-use` is the optional matching hint; it rides after the
    // description and is the first thing dropped when space is tight.
    const desc = `${s.description || "(no description)"}${s.whenToUse ? ` (when: ${s.whenToUse})` : ""}`;
    const room = share - head.length;
    let line: string;
    if (room >= 8) {
      line = head + (desc.length > room ? `${desc.slice(0, room - 1).trimEnd()}…` : desc);
    } else {
      line = `- ${s.name}`; // keep it discoverable even with no room for prose
    }
    if (line.length > remaining) {
      const rest = skills.length - i;
      lines.push(`- (+${rest} more — names only, descriptions too long to fit)`);
      break;
    }
    lines.push(line);
    remaining -= line.length + 1;
  }
  return lines.join("\n");
}

/** Find a skill by name (trimmed, case-insensitive). */
export function findSkill(skills: UserSkill[], name: string): UserSkill | null {
  const want = normalizeSkillName(name);
  if (!want) return null;
  return skills.find((s) => normalizeSkillName(s.name) === want) ?? null;
}

/**
 * Full body of one skill for injection when the agent calls use_skill.
 * `null` = no such skill; `""` = the skill exists but its SKILL.md has no
 * instructions below the frontmatter (callers must not report that as
 * "not found").
 */
export function skillBody(skills: UserSkill[], name: string): string | null {
  const s = findSkill(skills, name);
  return s ? s.body : null;
}
