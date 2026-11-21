// dynamic-tools.ts — rank the MCP surface against the current turn.
//
// A user with eight connectors can easily reach 200 MCP tools. Handing all of
// them to the model in full costs tens of thousands of prompt tokens per turn
// and measurably degrades tool choice (models pick the wrong server's
// look-alike tool). The cap in tool-builder (MCP_TOOL_CAP) already stops the
// blow-up by shrinking every schema to a name, but a names-only list of 200
// entries is still 200 entries.
//
// This module answers a narrower question: given the user's turn, which tools
// deserve a full schema right now? Everything else stays reachable through
// mcp_search_tools / mcp_describe_tool, so nothing becomes uncallable — the
// roster is a ranking, not a filter.
//
// Pure and deterministic: same tools + same query → same order. No clock, no
// randomness, no I/O. That makes it testable and means a prompt cache key
// built from the routed set stays stable within a turn.

import { mcpToolName } from "./registry";
import type { BuilderTool } from "./tool-builder";

/** Below this many tools, routing cannot pay for itself. */
export const ROUTE_MIN_TOOLS = 12;

/** Words too common to discriminate between tools. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "your", "you",
  "are", "was", "were", "have", "has", "had", "can", "could", "would", "should",
  "will", "what", "when", "where", "which", "who", "how", "why", "all", "any",
  "get", "set", "use", "using", "tool", "tools", "call", "mcp", "please", "make",
  "need", "want", "some", "then", "than", "there", "their", "its", "it's",
]);

export interface RouteOptions {
  /** The turn text (or any keyword blob) to rank against. */
  query?: string;
  /** Full tool names, bare tool names, or server ids that are never routed away. */
  pinned?: string[];
  /** How many tools keep a full schema. */
  max?: number;
  /** `false` disables routing (returns every tool active). */
  enabled?: boolean;
}

export interface RouteResult {
  /** Tools that keep their full schema this turn, best first. */
  active: BuilderTool[];
  /** Tools still callable, but only reachable through the meta tools. */
  hidden: BuilderTool[];
  /** False when the roster was small enough (or routing was off) to skip it. */
  applied: boolean;
  /** True when a pinned name matched no tool (a typo the host should see). */
  unmatchedPins: string[];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/** Cheap, explainable scoring: name hits beat server hits beat description hits. */
function score(tool: BuilderTool, tokens: string[]): number {
  if (!tokens.length) return 0;
  const name = tool.name.toLowerCase();
  const server = tool.server.toLowerCase();
  const desc = (tool.description ?? "").toLowerCase();
  let total = 0;
  for (const token of tokens) {
    if (name.includes(token)) total += 5;
    else if (name.split("_").includes(token)) total += 2; // exact segment, weaker
    if (server.includes(token)) total += 3;
    if (desc.includes(token)) total += 1;
  }
  return total;
}

/** Pinned entries may be written as `mcp__server__tool`, `tool`, or `server`. */
function isPinned(tool: BuilderTool, pins: Set<string>): boolean {
  return (
    pins.has(mcpToolName(tool.server, tool.name).toLowerCase()) ||
    pins.has(tool.name.toLowerCase()) ||
    pins.has(tool.server.toLowerCase())
  );
}

/**
 * Split the roster into "show now" and "discover later".
 *
 * Ordering, which is also the contract the prompt relies on:
 *   1. pinned tools, in the host's order;
 *   2. tools that match the query, highest score first (ties: name asc);
 *   3. everything else, name asc — so a query-less turn still shows a stable
 *      alphabetical slice instead of an arbitrary one.
 */
export function routeTools(tools: BuilderTool[], options: RouteOptions = {}): RouteResult {
  const enabled = options.enabled !== false;
  const max = Math.max(1, Math.floor(options.max ?? tools.length));
  const pins = new Set((options.pinned ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean));

  const unmatchedPins: string[] = [];
  for (const pin of pins) {
    const hit = tools.some((t) => isPinned(t, new Set([pin])));
    if (!hit) unmatchedPins.push(pin);
  }

  if (!enabled || tools.length <= Math.max(max, ROUTE_MIN_TOOLS)) {
    return { active: [...tools], hidden: [], applied: false, unmatchedPins };
  }

  const tokens = tokenize(options.query ?? "");
  const active: BuilderTool[] = [];
  const rest: Array<{ tool: BuilderTool; score: number }> = [];

  for (const tool of tools) {
    if (isPinned(tool, pins)) active.push(tool);
    else rest.push({ tool, score: score(tool, tokens) });
  }

  rest.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return mcpToolName(a.tool.server, a.tool.name).localeCompare(mcpToolName(b.tool.server, b.tool.name));
  });

  for (const { tool } of rest) {
    if (active.length >= max) break;
    active.push(tool);
  }

  const activeNames = new Set(active.map((t) => mcpToolName(t.server, t.name)));
  const hidden = tools.filter((t) => !activeNames.has(mcpToolName(t.server, t.name)));
  return { active, hidden, applied: true, unmatchedPins };
}
