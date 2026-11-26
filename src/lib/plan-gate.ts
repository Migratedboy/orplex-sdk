// plan-gate.ts — The hard plan-approval latch (Claude Code parity).
//
// In plan mode the agent MUST present a plan and WAIT for explicit user
// approval before any state-changing tool runs. The latch is a small
// module-level map: taskId → approved?, flipped only by the approval
// decision. Writes before approval are refused with a tool result the model
// can read and adapt to (same UX as toolHooks deny / the plan-first gate).
//
// Server-executor parity: the executor checks ApprovalRequest.status in the
// DB (its approvals flow through /api/agent/approve), so this module also
// exposes seedApproved() for the route that records the DB decision.

import { toolWritesWorkspace } from "./tool-registry";

type LatchState = "unlatched" | "approved" | "rejected";

const latches = new Map<string, LatchState>();

/** Test hook. */
export function resetPlanGate(): void {
  latches.clear();
}

export function isPlanApproved(taskId: string): boolean {
  return latches.get(taskId) === "approved";
}

export function isPlanRejected(taskId: string): boolean {
  return latches.get(taskId) === "rejected";
}

/** The user approved the plan — the latch opens for this task. */
export function approvePlan(taskId: string): void {
  latches.set(taskId, "approved");
}

/** The user rejected — the agent must re-plan (latch stays closed). */
export function rejectPlan(taskId: string): void {
  latches.set(taskId, "rejected");
}

/** A finished/cleared task drops its latch (bounded map). */
export function clearPlanLatch(taskId: string): void {
  latches.delete(taskId);
}

// Every tool that can change the workspace belongs here. Derived from the tool
// registry (src/lib/tool-definitions.ts) rather than kept by hand: batch_edit,
// write_file_chunk and undo_last_change were all missing, so in plan mode the
// agent could still rewrite, append to, or revert files without an approved
// plan. They each request their own approval (native-tools.ts), but the plan
// gate is a stronger contract - nothing state-changing runs until the plan is
// approved, and these must not be the way around it.
/**
 * The gate blocks anything that can change the WORKSPACE, plus MCP (an opaque
 * server tool can write files or spend money).
 *
 * This set used to be hand-written here and had drifted from reality in both
 * directions: it listed `move_file` / `delete_file`, which no dispatcher
 * implements, and omitted `run_in_sandbox`, `extract_archive`, `apply_edit_ops`
 * and every MCP tool — so plan mode could unpack an archive, run code, or call
 * out to a server before the plan was approved. It now comes from
 * `tool-registry.ts`, the single categorisation table shared by both lanes.
 */
export function planBlockedTool(name: string): boolean {
  return toolWritesWorkspace(name);
}

/**
 * Should this tool call be blocked by the plan latch? Only meaningful in
 * plan mode — callers gate the call itself.
 */
export function planGateBlocks(taskId: string, toolName: string): boolean {
  if (!planBlockedTool(toolName)) return false;
  return !isPlanApproved(taskId);
}

export function planGateMessage(toolName: string): string {
  return (
    `BLOCKED by plan gate: in plan mode, ${toolName} requires an approved plan. ` +
    `Present your plan (todo_list + a clear proposal), then wait for the user's approval. ` +
    `If the plan was rejected, revise it before retrying. ` +
    (toolName.startsWith("mcp__") || toolName === "mcp_call"
      ? `MCP tools are opaque to the gate (a server tool can write files), so they are gated like workspace writes.`
      : ``)
  );
}
