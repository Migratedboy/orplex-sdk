// Process lifecycle: spawn tracking, tree kill, and the shutdown sweep.
//
// Uses a real child process that stays alive on purpose, so the assertions are
// about the OS state (does the PID answer?) rather than about bookkeeping.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  trackProcess,
  untrackProcess,
  listTrackedProcesses,
  resetTrackedProcessesForTests,
  shutdownAllSpawnedProcesses,
  killTree,
} from "../dist/esm/mcp.js";
import { shutdownAllMcp } from "../dist/esm/mcp.js";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function spawnSleep(ms = 60_000) {
  const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`], { stdio: "ignore", windowsHide: true });
  return child;
}

const waitForExit = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", resolve);
  });

test.beforeEach(() => resetTrackedProcessesForTests());

test("a tracked process is listed, then forgotten on untrack", () => {
  trackProcess(4242, { server: "demo", command: "npx" });
  assert.deepEqual(listTrackedProcesses().map((p) => p.pid), [4242]);
  untrackProcess(4242);
  assert.equal(listTrackedProcesses().length, 0);
});

test("nonsense PIDs are ignored rather than tracked", () => {
  trackProcess(0, { server: "x", command: "y" });
  trackProcess(undefined, { server: "x", command: "y" });
  trackProcess(Number.NaN, { server: "x", command: "y" });
  assert.equal(listTrackedProcesses().length, 0);
});

test("killTree really terminates a live child", async () => {
  const child = spawnSleep();
  assert.ok(alive(child.pid), "the child should be running");
  const killed = await killTree(child.pid);
  await waitForExit(child);
  assert.equal(killed, true);
  assert.equal(alive(child.pid), false, "the PID must be gone, not just signalled");
});

test("shutdownAllSpawnedProcesses reaps every tracked child and clears the registry", async () => {
  const a = spawnSleep();
  const b = spawnSleep();
  trackProcess(a.pid, { server: "a", command: "npx" });
  trackProcess(b.pid, { server: "b", command: "uvx" });

  const reaped = await shutdownAllSpawnedProcesses();
  await Promise.all([waitForExit(a), waitForExit(b)]);

  assert.equal(reaped, 2, "the count is what the host logs");
  assert.equal(alive(a.pid), false);
  assert.equal(alive(b.pid), false);
  assert.equal(listTrackedProcesses().length, 0, "the registry must not keep dead PIDs");
});

test("shutdownAllMcp is idempotent and reports what it reaped", async () => {
  const child = spawnSleep();
  trackProcess(child.pid, { server: "leftover", command: "npx" });

  const first = await shutdownAllMcp();
  await waitForExit(child);
  assert.equal(first.processes, 1);
  assert.equal(alive(child.pid), false);

  const second = await shutdownAllMcp();
  assert.deepEqual(second, { sessions: 0, processes: 0 }, "a second sweep is a no-op, not a crash");
});
