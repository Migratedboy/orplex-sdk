// tool-registry.ts — ONE table of tool categories for every lane.
//
// Why this file exists: the product used to keep six hand-written name lists —
// plan-gate WRITE_TOOLS, capability-policy WRITE/COMMAND_TOOLS,
// contract/tools STATE_CHANGING_TOOLS, loop-detect READ_ONLY_TOOLS,
// reliability/tool-args WRITE/MUTATING_TOOL_NAMES and the master prompt's
// category regex. They drifted exactly as you would expect: the plan gate
// blocked `run_command` but not `extract_archive` (which writes files) or
// `run_in_sandbox` (which executes code), while gating `move_file` and
// `delete_file`, which no dispatcher implements.
//
// Rules this table encodes, in one place:
//
//   readOnly  — never counts toward the loop streak, never needs approval
//               (reads, searches, screenshots, MCP metadata lookups).
//   writes    — can change the WORKSPACE: files directly, or anything a
//               spawned command/sandbox run does. This is the set the plan
//               gate blocks until the plan is approved.
//   mutating  — approval/streak-relevant state changes: everything that
//               writes, plus page actions and MCP calls. Superset of `writes`.
//
// Unknown tools are treated as `mutating` (count toward loop detection) but not
// `writes` (so a plan-mode run is never blocked from calling something it
// legitimately needs). MCP tools are handled by name shape, because their
// per-server names are discovered at runtime.

export interface ToolCategory {
  /** Can change workspace contents (files, or a command/sandbox run). */
  writes: boolean;
  /** Changes any durable state (writes, page actions, MCP, app memory). */
  mutating: boolean;
  /** Pure read: exempt from loop streaks and from approval gating. */
  readOnly: boolean;
}

const READ: ToolCategory = { writes: false, mutating: false, readOnly: true };
const WRITE: ToolCategory = { writes: true, mutating: true, readOnly: false };
const ACT: ToolCategory = { writes: false, mutating: true, readOnly: false };

/**
 * The table. Keep it alphabetical inside each block so a reviewer can diff it
 * against `tool-definitions.ts` without hunting.
 */
export const TOOL_CATEGORIES: Readonly<Record<string, ToolCategory>> = {
  // ── Workspace writes ────────────────────────────────────────────────────
  apply_edit_ops: WRITE,
  batch_edit: WRITE,
  edit_file: WRITE,
  extract_archive: WRITE,
  run_command: WRITE,
  run_in_sandbox: WRITE,
  undo_last_change: WRITE,
  write_file: WRITE,
  write_file_chunk: WRITE,

  // ── Page interaction (durable side effects outside the workspace) ───────
  browser_click: ACT,
  browser_evaluate: ACT,
  browser_hover: ACT,
  browser_navigate: ACT,
  browser_press: ACT,
  browser_scroll: ACT,
  browser_select: ACT,
  browser_type: ACT,

  // ── App memory / deliverables (durable state, not the workspace) ────────
  create_file: ACT,
  memory_append: ACT,
  memory_delete: ACT,
  memory_str_replace: ACT,
  memory_write: ACT,
  mcp_call: ACT,
  skill_create: ACT,

  // ── Sub-agents (cost turns; not a direct write) ─────────────────────────
  spawn_subagent: ACT,

  // ── Reads, searches, screenshots, MCP metadata ──────────────────────────
  browser_console: READ,
  browser_find: READ,
  browser_network: READ,
  browser_read: READ,
  browser_screenshot: READ,
  browser_tabs: READ,
  browser_wait_for: READ,
  code_search: READ,
  list_files: READ,
  mcp_describe_tool: READ,
  mcp_search_tools: READ,
  memory_list: READ,
  memory_read: READ,
  playbook_search: READ,
  preview_browser: READ,
  read_file: READ,
  search_code: READ,
  session_search: READ,
  take_screenshot: READ,
  verify_app: READ,
  web_search: READ,

  // ── Conversation notes (no durable state, never gated) ──────────────────
  ask_clarification: READ,
  ask_question: READ,
  scratchpad_update: READ,
  todo_list: READ,
  use_skill: READ,
};

const UNKNOWN: ToolCategory = { writes: false, mutating: true, readOnly: false };

/** `mcp_call` plus every per-server tool (`mcp__server__tool`). */
export function isMcpTool(name: string): boolean {
  return name === "mcp_call" || name.startsWith("mcp__");
}

export function toolCategory(name: string): ToolCategory {
  return TOOL_CATEGORIES[name] ?? UNKNOWN;
}

/**
 * Does this tool call change the workspace?
 *
 * MCP is deliberately included: a server tool can write files, post messages or
 * spend money, and its contract is opaque to us. `mcp_search_tools` /
 * `mcp_describe_tool` are metadata lookups and stay out (they are in the table
 * as reads).
 */
export function toolWritesWorkspace(name: string): boolean {
  if (isMcpTool(name)) return true;
  return toolCategory(name).writes;
}

export function toolIsMutating(name: string): boolean {
  if (isMcpTool(name)) return true;
  return toolCategory(name).mutating;
}

export function toolIsReadOnly(name: string): boolean {
  if (isMcpTool(name)) return false;
  return toolCategory(name).readOnly;
}

/** Derived sets — the only definitions of these sets in the codebase. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(
  Object.entries(TOOL_CATEGORIES)
    .filter(([, c]) => c.writes)
    .map(([name]) => name),
);

export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.entries(TOOL_CATEGORIES)
    .filter(([, c]) => c.mutating)
    .map(([name]) => name),
);

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(
  Object.entries(TOOL_CATEGORIES)
    .filter(([, c]) => c.readOnly)
    .map(([name]) => name),
);

/**
 * Tools whose classification the plan gate and the loop guard both care about,
 * exported for tests that assert the two lanes agree.
 */
export const STATE_CHANGING_TOOLS: ReadonlySet<string> = new Set(
  Object.entries(TOOL_CATEGORIES)
    .filter(([, c]) => c.writes || (c.mutating && !c.readOnly))
    .map(([name]) => name),
);
