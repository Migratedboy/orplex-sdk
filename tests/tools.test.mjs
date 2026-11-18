// Tool-layer contract tests: the SDK must expose the same tool surface the app
// shipped with, and dispatch must refuse unknown tools instead of guessing.
import test from "node:test";
import assert from "node:assert/strict";
import { M3_TOOL_DEFINITIONS, LEAN_TOOL_DEFINITIONS, LEAN_TOOL_NAMES, usesCompactTools } from "../dist/esm/tools.js";
import { dispatchToolCall, createToolContext } from "../dist/esm/tools.js";

test("the full tool surface is exported", () => {
  assert.ok(Array.isArray(M3_TOOL_DEFINITIONS));
  assert.ok(M3_TOOL_DEFINITIONS.length >= 40, `expected >= 40 tools, got ${M3_TOOL_DEFINITIONS.length}`);
  const names = M3_TOOL_DEFINITIONS.map((t) => t.function.name);
  assert.equal(new Set(names).size, names.length, "tool names must be unique");
  for (const required of ["read_file", "write_file", "edit_file", "run_command", "list_files", "search_code"]) {
    assert.ok(names.includes(required), `missing required tool: ${required}`);
  }
});

test("every tool declares a JSON schema with an object root", () => {
  for (const tool of M3_TOOL_DEFINITIONS) {
    assert.equal(tool.type, "function");
    assert.equal(tool.function.parameters.type, "object", `${tool.function.name} parameters must be an object`);
    assert.ok(tool.function.description && tool.function.description.length > 10, `${tool.function.name} needs a description`);
  }
});

test("the lean tool set is a strict subset of the full set", () => {
  const full = new Set(M3_TOOL_DEFINITIONS.map((t) => t.function.name));
  for (const tool of LEAN_TOOL_DEFINITIONS) assert.ok(full.has(tool.function.name));
  for (const name of LEAN_TOOL_NAMES) assert.ok(full.has(name));
  assert.ok(usesCompactTools("nvidia"));
  assert.equal(usesCompactTools("anthropic"), false);
});

test("dispatch refuses an unknown tool with an honest roster message", async () => {
  const ctx = createToolContext();
  const outcome = await dispatchToolCall({ id: "1", name: "definitely_not_a_tool", arguments: "{}" }, ctx);
  assert.equal(outcome.blocked, false);
  assert.match(outcome.resultXml, /not available in this environment/);
  assert.match(outcome.resultXml, /read_file/);
  assert.match(ctx.getDisplay(), /not available here/);
});

test("dispatch names MISSING ARGUMENTS when a real tool arrives incomplete", async () => {
  const ctx = createToolContext();
  const outcome = await dispatchToolCall({ id: "2", name: "read_file", arguments: "{}" }, ctx);
  assert.equal(outcome.blocked, true);
  assert.match(outcome.resultXml, /missing required argument\(s\) \(path\)/);
});
