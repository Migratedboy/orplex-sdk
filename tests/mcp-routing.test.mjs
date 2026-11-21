// Routing decides which MCP tools keep a full schema in the prompt. The tests
// care about three properties: nothing becomes uncallable, the order is stable,
// and a host's pins are honoured exactly.
import test from "node:test";
import assert from "node:assert/strict";

const { routeTools, ROUTE_MIN_TOOLS } = await import("../dist/esm/lib/mcp/dynamic-tools.js");
const { buildMcpRoster, mcpPromptSection } = await import("../dist/esm/lib/mcp/tool-builder.js");

const tool = (server, name, description = "") => ({
  server,
  name,
  description,
  inputSchema: { type: "object", properties: { q: { type: "string" } } },
});

const many = (n, server = "linear") =>
  Array.from({ length: n }, (_, i) => tool(server, `tool_${i}`, `does thing ${i}`));

test("a small roster is never routed away", () => {
  const tools = many(ROUTE_MIN_TOOLS);
  const r = routeTools(tools, { query: "issue", max: 3 });
  assert.equal(r.applied, false);
  assert.equal(r.active.length, tools.length);
  assert.equal(r.hidden.length, 0);
});

test("routing caps the active set and keeps the rest callable", () => {
  const tools = many(60);
  const r = routeTools(tools, { query: "tool_42", max: 5 });
  assert.equal(r.applied, true);
  assert.equal(r.active.length, 5);
  assert.equal(r.active.length + r.hidden.length, tools.length);
  assert.equal(r.active[0].name, "tool_42", "the queried tool ranks first");
});

test("pinned tools survive routing even when they score zero", () => {
  const tools = [...many(40), tool("github", "create_issue", "opens an issue")];
  const r = routeTools(tools, { query: "database schema", max: 3, pinned: ["mcp__github__create_issue"] });
  assert.ok(r.active.some((t) => t.name === "create_issue"), "pin kept");
  assert.equal(r.active[0].name, "create_issue", "pins come first");
  assert.deepEqual(r.unmatchedPins, []);
});

test("pins may be bare tool names or server ids", () => {
  const tools = many(40);
  const byName = routeTools(tools, { query: "", max: 2, pinned: ["tool_9"] });
  assert.ok(byName.active.some((t) => t.name === "tool_9"));
  const byServer = routeTools(tools, { query: "", max: 2, pinned: ["linear"] });
  assert.equal(byServer.active.length, 40, "pinning the server pins every tool under it");
});

test("a pin that matches nothing is reported instead of swallowed", () => {
  const r = routeTools(many(40), { query: "x", max: 4, pinned: ["mcp__ghost__nope"] });
  assert.deepEqual(r.unmatchedPins, ["mcp__ghost__nope"]);
});

test("routing off returns everything, exactly like 0.3.x", () => {
  const r = routeTools(many(80), { query: "tool_1", max: 3, enabled: false });
  assert.equal(r.applied, false);
  assert.equal(r.active.length, 80);
});

test("ordering is deterministic for the same input", () => {
  const tools = many(50);
  const a = routeTools(tools, { query: "tool 7", max: 8 }).active.map((t) => t.name);
  const b = routeTools(tools, { query: "tool 7", max: 8 }).active.map((t) => t.name);
  assert.deepEqual(a, b);
});

test("the roster gives schemas to active tools and names to hidden ones", () => {
  const tools = [
    ...many(30, "linear"),
    tool("postgres", "run_query", "runs sql against the database"),
  ];
  const roster = buildMcpRoster(tools, { route: { query: "sql query", max: 4 } });
  assert.equal(roster.routing.applied, true);
  assert.equal(roster.defs.length, 4);
  assert.equal(roster.defs[0].name, "mcp__postgres__run_query");
  assert.ok(roster.defs[0].parameters.properties.q, "active tool keeps its schema");
  assert.equal(roster.routing.hidden.length, tools.length - 4);
  // Everything still appears in the roster's own tool list and server summary.
  assert.equal(roster.tools.length, tools.length);
  assert.equal(roster.servers.reduce((s, x) => s + x.toolCount, 0), tools.length);

  const prompt = mcpPromptSection(roster);
  assert.match(prompt, /4 of 31 external tools loaded/);
  assert.match(prompt, /MORE MCP TOOLS — 27 not loaded/);
  assert.match(prompt, /mcp_search_tools/, "hidden tools are discoverable, not lost");
});

test("routing is not applied unless a host asks for it", () => {
  const roster = buildMcpRoster(many(30), {});
  assert.equal(roster.routing, undefined);
  assert.equal(roster.defs.length, 30);
});
