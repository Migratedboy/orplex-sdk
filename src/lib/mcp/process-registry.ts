// process-registry.ts — every MCP child the SDK has spawned, in one place.
//
// Why this exists: `proc.kill()` is not enough on Windows. The SDK launches
// `cmd /d /s /c npx -y @some/mcp` (the shim is a .cmd, so it needs a shell), so
// the child immediately forks node again. Killing cmd.exe leaves the real server
// running with an inherited pipe — a zombie that keeps a handle on the app's
// temp files, its port, and the user's memory until they log out.
//
// The registry tracks PIDs (not just ChildProcess handles) so that:
//   • shutdown() can kill the whole tree,
//   • Electron's before-quit can sweep everything the SDK started,
//   • a crashed/hung child is still known to us after its handle is gone.

import { execFile } from "node:child_process";

export interface TrackedProcess {
  pid: number;
  server: string;
  command: string;
  startedAt: number;
}

const tracked = new Map<number, TrackedProcess>();

/** Record a spawned child so shutdown can reap it later. */
export function trackProcess(pid: number | undefined, meta: Omit<TrackedProcess, "pid" | "startedAt"> & { startedAt?: number }): void {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return;
  tracked.set(pid, { pid, startedAt: meta.startedAt ?? Date.now(), server: meta.server, command: meta.command });
}

/** Forget a child (called on exit, so a clean exit never looks like a leak). */
export function untrackProcess(pid: number | undefined): void {
  if (typeof pid === "number") tracked.delete(pid);
}

/** Snapshot of live children — for diagnostics and host quit handlers. */
export function listTrackedProcesses(): TrackedProcess[] {
  return [...tracked.values()];
}

function run(command: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: timeoutMs, windowsHide: true }, () => resolve());
    } catch {
      resolve();
    }
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Terminate one PID and everything it spawned.
 *
 * Windows: `taskkill /T /F` walks the process tree; there is no signal-based
 * graceful path for console children, so this is a hard kill by design.
 * POSIX: SIGTERM, then SIGKILL after a short grace period.
 */
export async function killTree(pid: number, graceMs = 400): Promise<boolean> {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"], 5_000);
    return true;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  await sleep(graceMs);
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  return true;
}

/**
 * Kill every tracked child. Returns how many trees were signalled, so a host
 * can log "reaped 2 MCP servers" instead of claiming success blindly.
 */
export async function shutdownAllSpawnedProcesses(): Promise<number> {
  const all = [...tracked.values()];
  tracked.clear();
  if (!all.length) return 0;
  await Promise.all(all.map((p) => killTree(p.pid)));
  return all.length;
}

/** Test seam — drop bookkeeping without touching real processes. */
export function resetTrackedProcessesForTests(): void {
  tracked.clear();
}
