// Text-mode tool calls: the shapes weak/free models actually emit.
//
// Live failure this pins: a provider returned no tool_calls array and no XML,
// just content —
//   {"cmd":"ls -la","cwd":"/workspace"} {"tool":"terminal","args":{"cmd":"find . …"}}
// The client rendered that JSON as the assistant's answer, the call never ran,
// and the agent then reported the workspace as empty. Recovery must:
//   1. understand both shapes and the invented tool name,
//   2. normalize to the roster's run_command + its `command` parameter,
//   3. hand back CLEANED text so raw JSON is never shown,
//   4. leave genuine answers that merely contain JSON untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { extractBareJsonToolCalls, parseBareJsonToolCalls } from "../dist/esm/lib/tool-text.js";

test("recovers a two-object turn and strips both from the text", () => {
  const text = '{"cmd":"ls -la","cwd":"/workspace"} {"tool":"terminal","args":{"cmd":"find . -type f | head -20","cwd":"/workspace"}}';
  const out = extractBareJsonToolCalls(text);
  assert.equal(out.calls.length, 2);
  for (const call of out.calls) {
    assert.equal(call.name, "run_command");
    assert.equal(typeof call.command, "string");
    assert.ok(call.command.length > 0);
  }
  assert.equal(out.cleaned, "");
});

test("maps invented tool names onto run_command", () => {
  for (const name of ["terminal", "bash", "shell", "execute_command", "run_terminal_cmd"]) {
    const out = extractBareJsonToolCalls(`{"tool":"${name}","args":{"cmd":"dir /b"}}`);
    assert.equal(out.calls.length, 1, name);
    assert.equal(out.calls[0].name, "run_command");
    assert.equal(out.calls[0].command, "dir /b");
  }
});

test("keeps a real tool name and its parameters as-is", () => {
  const out = extractBareJsonToolCalls('{"name":"read_file","path":"package.json"}');
  assert.equal(out.calls[0].name, "read_file");
  assert.equal(out.calls[0].path, "package.json");
});

test("accepts {name, arguments} (OpenAI tool-call shape as text)", () => {
  const out = extractBareJsonToolCalls('{"name":"grep","arguments":{"pattern":"TODO"}}');
  assert.equal(out.calls[0].name, "grep");
  assert.equal(out.calls[0].pattern, "TODO");
});

test("allows a short lead-in line", () => {
  const out = extractBareJsonToolCalls('Listing files now:\n{"tool":"terminal","args":{"cmd":"dir /b"}}');
  assert.equal(out.calls.length, 1);
  assert.equal(out.cleaned, "Listing files now:");
});

test("never turns a real answer into a call", () => {
  const answer =
    "The config file looks like this:\n\n" +
    '```json\n{"name": "my-app", "version": "1.0.0", "private": true}\n```\n\n' +
    "That `name` field is what npm publishes under, so keep it lowercase and unique.";
  const out = extractBareJsonToolCalls(answer);
  assert.equal(out.calls.length, 0);
  assert.equal(out.cleaned, answer);
});

test("a command object with no command string is not a call", () => {
  const out = extractBareJsonToolCalls('{"cmd":"","cwd":"/workspace"}');
  assert.equal(out.calls.length, 0);
});

test("back-compat wrapper still returns just the calls", () => {
  assert.equal(parseBareJsonToolCalls('{"cmd":"claude"}').length, 1);
  assert.equal(parseBareJsonToolCalls("no json here").length, 0);
});
