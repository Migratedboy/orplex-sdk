// Argument pre-flight. The failure mode this guards against is over-rejection:
// refusing a call the server would have accepted is worse than not checking, so
// the "unconstrained schema passes" cases matter as much as the errors.
import test from "node:test";
import assert from "node:assert/strict";

const { validateToolArgs } = await import("../dist/esm/lib/mcp/validate-args.js");

test("no schema means no constraint", () => {
  assert.equal(validateToolArgs(undefined, { anything: 1 }).ok, true);
  assert.equal(validateToolArgs({}, { anything: 1 }).ok, true);
  assert.equal(validateToolArgs({ type: "object" }, { anything: 1 }).ok, true);
});

test("required keys are named individually", () => {
  const r = validateToolArgs(
    { type: "object", properties: { owner: {}, repo: {} }, required: ["owner", "repo"] },
    { owner: "acme" },
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /repo: required/);
  assert.doesNotMatch(r.errors.join("\n"), /owner: required/);
});

test("wrong types are reported with what arrived", () => {
  const r = validateToolArgs({ type: "object", properties: { limit: { type: "integer" } } }, { limit: "10" });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /limit: expected integer, got string/);
});

test("numbers accept the number type for integers, not the reverse", () => {
  const asNumber = { type: "object", properties: { n: { type: "number" } } };
  assert.equal(validateToolArgs(asNumber, { n: 1.5 }).ok, true);
  assert.equal(validateToolArgs(asNumber, { n: 2 }).ok, true);
  const asInt = { type: "object", properties: { n: { type: "integer" } } };
  assert.equal(validateToolArgs(asInt, { n: 1.5 }).ok, false);
});

test("enum, const and pattern are enforced", () => {
  const schema = {
    type: "object",
    properties: {
      mode: { enum: ["fast", "safe"] },
      branch: { const: "main" },
      sha: { type: "string", pattern: "^[0-9a-f]{7,40}$" },
    },
  };
  assert.equal(validateToolArgs(schema, { mode: "fast", branch: "main", sha: "abc1234" }).ok, true);
  const bad = validateToolArgs(schema, { mode: "turbo", branch: "dev", sha: "nope" });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 3);
});

test("additionalProperties:false catches mistyped argument names", () => {
  const schema = {
    type: "object",
    properties: { query: { type: "string" } },
    additionalProperties: false,
  };
  const r = validateToolArgs(schema, { querry: "typo" });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /querry: not an accepted argument/);
  // A schema WITHOUT additionalProperties:false must still allow extras:
  // over-rejection would break servers that accept flexible bags.
  const lenient = { type: "object", properties: { query: { type: "string" } } };
  assert.equal(validateToolArgs(lenient, { query: "x", extra: 1 }).ok, true);
});

test("arrays validate their items and bounds", () => {
  const schema = {
    type: "object",
    properties: { tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 } },
  };
  assert.equal(validateToolArgs(schema, { tags: ["a"] }).ok, true);
  assert.equal(validateToolArgs(schema, { tags: [] }).ok, false);
  const three = validateToolArgs(schema, { tags: ["a", "b", "c"] });
  assert.equal(three.ok, false);
  const badItem = validateToolArgs(schema, { tags: ["a", 2] });
  assert.equal(badItem.ok, false);
  assert.match(badItem.errors[0], /tags\[1\]: expected string/);
});

test("nested objects report a full path", () => {
  const schema = {
    type: "object",
    properties: {
      config: { type: "object", properties: { depth: { type: "integer" } }, required: ["depth"] },
    },
  };
  const r = validateToolArgs(schema, { config: { depth: "deep" } });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /config\.depth/);
});

test("union types are allowed", () => {
  const schema = { type: "object", properties: { v: { type: ["string", "null"] } } };
  assert.equal(validateToolArgs(schema, { v: null }).ok, true);
  assert.equal(validateToolArgs(schema, { v: "x" }).ok, true);
  assert.equal(validateToolArgs(schema, { v: 1 }).ok, false);
});
