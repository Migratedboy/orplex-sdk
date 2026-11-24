// The turn-loop harness: termination, wasted turns, dispatch ordering.
//
// Live failures these pin:
//   1. "Keep going?" reset the lane counters but the engine's turn cap was a
//      plain number, so the run hit turn-limit two turns after the user
//      granted more work.
//   2. A model whose write_file keeps getting cut off by the output budget
//      re-ran the model up to maxTurns times: the truncated-only path
//      `continue`d BEFORE the loop breaker, so nothing counted it.
//   3. A turn whose only calls were removed by the tool whitelist fell into the
//      no-calls path and ENDED the run, right after telling the model the tool
//      was unavailable.
//   4. dispatchTurnCalls keyed indices by object identity, so a repeated call
//      object left an earlier slot null ("error: dispatch failed" for a call
//      that never ran).

import test from "node:test";
import assert from "node:assert/strict";
import {
  runTurnLoop,
  createLoopStreaks,
  dispatchTurnCalls,
} from "../dist/esm/lib/agent/loop-engine.js";

const noopAbort = () => {
  throw new Error("abort");
};

/** A minimal lane: each turn returns the next scripted output. */
function lane(script, overrides = {}) {
  let turn = 0;
  const calls = [];
  return {
    calls,
    opts: {
      maxTurns: 20,
      throwAbort: noopAbort,
      loopStreaks: createLoopStreaks(),
      parseXmlToolCalls: () => [],
      onLoopTrip: () => "break",
      dispatchCall: async () => ({ resultXml: "<tool_result name=\"x\">ok</tool_result>" }),
      callModel: () => {
        // Every scripted entry: { content?, toolCalls?, truncated?, filtered? }
        const entry = script[Math.min(turn, script.length - 1)];
        turn++;
        calls.push(entry);
        return {
          content: entry.content ?? "",
          toolCalls: entry.toolCalls ?? [],
        };
      },
      ...overrides,
    },
  };
}

const truncatedCall = { name: "write_file", path: "index.html" }; // no content → truncated

test("a growable maxTurns actually extends the loop", async () => {
  // Base cap 2. The lane grants ONE extension (cap → 4), then finishes.
  let granted = 0;
  const l = lane(
    [
      { content: "first" },
      { content: "second" },
      { content: "third" },
      { content: "done" },
    ],
    {
      maxTurns: () => 2 + granted * 2,
      onNoToolCalls: () => {
        if (granted < 1) granted++; // exactly one "Continue working" grant
        return "continue";
      },
    }
  );
  const exit = await runTurnLoop(l.opts);
  assert.equal(exit.ended, "turn-limit");
  // With a fixed cap the run stopped after 2 calls; the grant must add turns.
  assert.equal(l.calls.length, 4, `expected 4 model calls, got ${l.calls.length}`);
});

test("truncated-only turns stop after maxWastedTurns instead of burning the cap", async () => {
  const l = lane(
    // always the same un-dispatchable write_file
    [{ toolCalls: [truncatedCall] }],
    {
      maxTurns: 50,
      maxWastedTurns: 3,
      dispatchCall: async () => {
        throw new Error("a truncated call must never be dispatched");
      },
      onNoToolCalls: () => "break",
    }
  );
  const exit = await runTurnLoop(l.opts);
  assert.equal(exit.ended, "no-calls");
  assert.equal(l.calls.length, 3, "the wasted-turn cap must stop the loop after 3 attempts");
});

test("whitelist-filtered turns are not mistaken for a final answer", async () => {
  let filteredSeen = 0;
  const l = lane(
    [
      { toolCalls: [{ name: "run_in_sandbox" }] },
      { content: "I cannot run that here, here is the answer instead." },
    ],
    {
      filterToolCalls: (name) => name !== "run_in_sandbox",
      onFilteredCalls: () => {
        filteredSeen++;
      },
    }
  );
  const exit = await runTurnLoop(l.opts);
  assert.equal(filteredSeen, 1);
  assert.equal(exit.ended, "no-calls");
  assert.equal(l.calls.length, 2, "the run must continue after the unavailable-tool notice");
});

test("dispatch indices are positional, so a repeated call object still runs", async () => {
  const shared = { name: "read_file", path: "a.txt" };
  const seen = [];
  const { results } = await dispatchTurnCalls(
    [shared, shared],
    async (call, index) => {
      seen.push(index);
      return { resultXml: `<tool_result name="${call.name}">${index}</tool_result>` };
    },
    1
  );
  assert.deepEqual(seen, [0, 1]);
  assert.equal(results.length, 2);
  assert.ok(!results.some((r) => r.includes("dispatch failed")), `unexpected failure: ${results.join(",")}`);
});
