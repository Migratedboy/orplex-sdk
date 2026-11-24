// Live tool-call lifecycle: the SDK must be able to describe a call that is
// PENDING, RUNNING and FINISHED, and must update one row in place as it moves.
//
// Why this file exists: the published protocol only allowed "running" and
// "dismissed", and appendLiveToolSteps skipped any call id it had already seen.
// Together that meant a live row could never settle — a UI had to delete the row
// at the moment the tool started, which is exactly how tool calls ended up
// appearing all at once in their final state.
import test from "node:test";
import assert from "node:assert/strict";
import { appendLiveToolSteps } from "../dist/esm/lib/activity.js";
import { emitLiveToolCall, onAgentStatus } from "../dist/esm/lib/agent-events.js";

function stepsOf(segments) {
  const out = [];
  for (const segment of segments) {
    if (segment.type === "activity" && segment.activity) out.push(...segment.activity.steps);
  }
  return out;
}

test("a call is added as `pending` from its name alone", () => {
  const rows = stepsOf(
    appendLiveToolSteps([], [{ id: "c1", tool: "read_file", args: {}, status: "pending" }], 1000)
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "pending");
  assert.equal(rows[0].kind, "read");
});

test("the same id is UPDATED in place as it starts — never duplicated", () => {
  let segments = appendLiveToolSteps([], [{ id: "c1", tool: "read_file", args: {}, status: "pending" }], 1000);
  segments = appendLiveToolSteps(
    segments,
    [{ id: "c1", tool: "read_file", args: { path: "a.ts" }, status: "running", startedAt: 1000 }],
    1000
  );
  const rows = stepsOf(segments);
  assert.equal(rows.length, 1, "one id must stay one row");
  assert.equal(rows[0].status, "live");
  assert.equal(rows[0].chip, "a.ts", "the target arrives with the arguments");
});

test("a finished call settles: status, end time and output land on the row", () => {
  let segments = appendLiveToolSteps([], [{ id: "c1", tool: "read_file", args: { path: "a.ts" }, status: "running" }], 1000);
  segments = appendLiveToolSteps(
    segments,
    [{ id: "c1", tool: "read_file", args: { path: "a.ts" }, status: "done", endedAt: 1040, output: "file text" }],
    1000
  );
  const [row] = stepsOf(segments);
  assert.equal(row.status, "done");
  assert.equal(row.endedAt, 1040);
  assert.equal(row.body, "file text");
});

test("a failed call settles as an error row", () => {
  let segments = appendLiveToolSteps([], [{ id: "c1", tool: "read_file", args: { path: "a.ts" }, status: "running" }], 1000);
  segments = appendLiveToolSteps(
    segments,
    [{ id: "c1", tool: "read_file", args: { path: "a.ts" }, status: "error", endedAt: 1010, output: "ENOENT" }],
    1000
  );
  const [row] = stepsOf(segments);
  assert.equal(row.status, "error");
  assert.equal(row.body, "ENOENT");
});

test("an unchanged re-report leaves the segments array identical (no needless rerender)", () => {
  const first = appendLiveToolSteps([], [{ id: "c1", tool: "read_file", args: { path: "a.ts" }, status: "running" }], 1000);
  const second = appendLiveToolSteps(
    first,
    [{ id: "c1", tool: "read_file", args: { path: "a.ts" }, status: "running" }],
    1000
  );
  assert.equal(second, first);
});

test("the emitter carries the lifecycle through to subscribers", () => {
  const seen = [];
  const off = onAgentStatus((event) => {
    if (event.type === "live-tool-call" && event.id === "life-1") seen.push(event);
  });
  try {
    emitLiveToolCall({ taskId: "t", id: "life-1", tool: "read_file", args: {}, status: "pending" });
    emitLiveToolCall({ taskId: "t", id: "life-1", tool: "read_file", args: { path: "a.ts" }, status: "running" });
    emitLiveToolCall({
      taskId: "t",
      id: "life-1",
      tool: "read_file",
      args: { path: "a.ts" },
      status: "done",
      endedAt: Date.now(),
    });
  } finally {
    off();
  }
  assert.deepEqual(seen.map((e) => e.status), ["pending", "running", "done"]);
  const started = seen[0].startedAt;
  assert.ok(started, "pending carries a start time");
  assert.equal(seen[1].startedAt, started, "the first start wins across the lifecycle");
  assert.equal(seen[2].startedAt, started, "the terminal event still reports when it began");
});

test("a terminal event releases the start time, so a reused id starts fresh", async () => {
  emitLiveToolCall({ taskId: "t", id: "life-2", tool: "read_file", args: {}, status: "pending" });
  const doneAt = Date.now();
  emitLiveToolCall({ taskId: "t", id: "life-2", tool: "read_file", args: {}, status: "done", endedAt: doneAt });
  await new Promise((resolve) => setTimeout(resolve, 3));
  const seen = [];
  const off = onAgentStatus((event) => {
    if (event.type === "live-tool-call" && event.id === "life-2") seen.push(event);
  });
  try {
    emitLiveToolCall({ taskId: "t", id: "life-2", tool: "read_file", args: {}, status: "pending" });
  } finally {
    off();
  }
  assert.ok(seen[0].startedAt > doneAt, "the stale start must not be reused");
});
