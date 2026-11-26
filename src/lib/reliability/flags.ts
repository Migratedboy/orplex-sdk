/**
 * reliability/flags.ts — the single source of truth for every reliability
 * feature flag.
 *
 * TWO CLASSES OF FLAG (B.L.A.S.T. audit, ARCHITECTURE.md §22):
 *
 *   ENFORCEMENT (default ON, opt out with `<VAR>=0`)
 *     path jail, tool-argument schema validation (edit-ops surface), extended
 *     loop guard (hard denylist + oscillation), durable failure memory.
 *     These only refuse or constrain a call that was already unsafe; leaving
 *     them off by default meant the whole reliability subsystem was dead code
 *     in every stock install while evidence collection kept running. They are
 *     armed now, and `RELIABILITY_GATES=0` disarms all of them at once.
 *
 *   EXPERIMENTS (default OFF, opt in with `<VAR>=1`)
 *     test lane, baseline diff, roles review, flake control, acceptance spec,
 *     verification report, provenance, injection scanning, capability policy.
 *
 * Pre-audit the repo read ~19 behavioural flags as scattered `process.env`
 * literals. This module centralises the RELIABILITY_* set so the defaults are
 * greppable in one place and the gating logic cannot drift.
 *
 * Enabling any sub-flag requires RELIABILITY_GATES=1 first — a lock that is
 * armed without a pipeline to enforce it is worse than no lock at all, because
 * it would refuse writes while nothing can ever clear the lock.
 */

/**
 * The declarative flag table — the thing docs, `npm run doctor` and the env
 * checker read instead of re-listing env names. Keep the `envVar` in sync with
 * the accessor below that reads it; the table exists so a typo'd name shows up
 * once instead of in three places.
 */
export type ReliabilityFlagKind = "enforcement" | "experiment" | "master";

export interface ReliabilityFlagDef {
  envVar: string;
  kind: ReliabilityFlagKind;
  /** What turning it on does, in one line. */
  summary: string;
}

export const RELIABILITY_FLAGS: readonly ReliabilityFlagDef[] = [
  { envVar: "RELIABILITY_GATES", kind: "master", summary: "Master switch for the experiment flags; =0 is a kill switch for enforcement too." },
  // Enforcement: armed unless =0.
  { envVar: "RELIABILITY_PATH_JAIL", kind: "enforcement", summary: "Refuse writes that resolve outside the workspace (realpath jail + write denylist)." },
  { envVar: "RELIABILITY_EDIT_OPS", kind: "enforcement", summary: "Validate tool arguments and enable the structured apply_edit_ops surface." },
  { envVar: "RELIABILITY_LOOP_GUARD", kind: "enforcement", summary: "Extended loop guard: hard denylist, oscillation and no-progress detection, budgets." },
  { envVar: "RELIABILITY_DURABLE_MEMORY", kind: "enforcement", summary: "Seed the failure doctrine, flake quarantine and compaction state from durable storage." },
  // Experiments: opt in with =1 (and RELIABILITY_GATES=1 where noted).
  { envVar: "RELIABILITY_EDIT_LOCK", kind: "experiment", summary: "Refuse further writes while a gate lane is red." },
  { envVar: "RELIABILITY_TEST_LANE", kind: "experiment", summary: "Run the jest lane as a gate (the slowest tier)." },
  { envVar: "RELIABILITY_BLOCK_BASELINE", kind: "experiment", summary: "Treat pre-existing baseline failures as blocking." },
  { envVar: "RELIABILITY_ROLES_REVIEW", kind: "experiment", summary: "Roles stack + cross-family reviewer panel + risk-tiered review depth." },
  { envVar: "RELIABILITY_REPORT", kind: "experiment", summary: "Compute and append the verification report at task close." },
  { envVar: "RELIABILITY_TAMPER_DETECT", kind: "experiment", summary: "Flag deleted/skipped tests in the task diff." },
  { envVar: "RELIABILITY_FLAKE_CONTROL", kind: "experiment", summary: "Rerun failed tests within budget and quarantine unstable ones." },
  { envVar: "RELIABILITY_ACCEPTANCE", kind: "experiment", summary: "Derive an acceptance spec from the task text and track it." },
  { envVar: "RELIABILITY_TAINT", kind: "experiment", summary: "Maintain provenance labels + the taint ledger." },
  { envVar: "RELIABILITY_INJECTION_SCAN", kind: "experiment", summary: "Scan untrusted content entering model context for prompt injection." },
  { envVar: "RELIABILITY_SCRUB", kind: "experiment", summary: "Redact secrets from tool output before it enters context." },
  { envVar: "RELIABILITY_CAPABILITY_POLICY", kind: "experiment", summary: "Turn provenance/taint/egress detection into refusals and approval demands." },
  { envVar: "RELIABILITY_PROTECTED_WRITE_OVERRIDE", kind: "experiment", summary: "Relax the elevated approval tier for protected test/CI paths." },
] as const;

/**
 * Master switch for the EXPERIMENT flags. `"1"` opts in.
 *
 * Enforcement flags no longer consult it (see `enforcementEnabled`), except that
 * `RELIABILITY_GATES=0` is an explicit kill switch for them too.
 */
export function reliabilityGatesEnabled(): boolean {
  try {
    return process.env.RELIABILITY_GATES === "1";
  } catch {
    return false;
  }
}

/**
 * Enforcement flags: ON unless explicitly disarmed.
 *
 * `RELIABILITY_GATES=0` wins over everything (the one-flag kill switch), then a
 * per-flag `=0`. Any other value — including unset — means armed.
 */
function enforcementEnabled(varName: string): boolean {
  try {
    if (process.env.RELIABILITY_GATES === "0") return false;
    return process.env[varName] !== "0";
  } catch {
    return true;
  }
}

/**
 * Refuse further writes while a gate lane is red (see edit-lock.ts). Requires
 * the master switch: a lock without a pipeline that can clear it would wedge a
 * task permanently.
 */
export function reliabilityEditLockEnabled(): boolean {
  try {
    return reliabilityGatesEnabled() && process.env.RELIABILITY_EDIT_LOCK === "1";
  } catch {
    return false;
  }
}

/**
 * Run the jest lane. Off by default even under the master switch because it is
 * the slowest tier (tens of seconds on a full suite); a user who wants the
 * test gate arms it explicitly.
 */
export function reliabilityTestLaneEnabled(): boolean {
  try {
    return reliabilityGatesEnabled() && process.env.RELIABILITY_TEST_LANE === "1";
  } catch {
    return false;
  }
}

/**
 * Treat pre-existing baseline failures as blocking. Off by default: the whole
 * point of baseline diagnostics is to distinguish "the agent broke this" from
 * "it was already broken", so a pre-existing failure must not block a task by
 * default — only a regression must.
 */
 function reliabilityBlockOnBaselineFailures(): boolean {
  try {
    return reliabilityGatesEnabled() && process.env.RELIABILITY_BLOCK_BASELINE === "1";
  } catch {
    return false;
  }
}

/**
 * Snapshot the workspace before writes (baseline.ts). On whenever the master
 * switch is on: without a baseline the gate cannot tell a regression from a
 * pre-existing failure, so the gate would have to block on every pre-existing
 * error — which is the behaviour the plan explicitly rejects.
 */
export function reliabilityBaselineEnabled(): boolean {
  return reliabilityGatesEnabled();
}

/**
 * Phase 7 — roles & review + the Verification Report (plan §14, §7). Gates the
 * cross-family reviewer panel, risk-tiered review depth, the role stack
 * (architect/developer/breaker/verifier/reviewer) and the verification-report
 * wiring at task close. OFF by default and inert without the master switch,
 * same rule as every other sub-flag: nothing from this phase runs — and none
 * of its model-call cost is paid — until the user opts in with
 * RELIABILITY_ROLES_REVIEW=1 on top of RELIABILITY_GATES=1.
 */
export function reliabilityRolesReviewEnabled(): boolean {
  try {
    return reliabilityGatesEnabled() && process.env.RELIABILITY_ROLES_REVIEW === "1";
  } catch {
    return false;
  }
}

/**
 * Phase 5 extended loop guard: oscillation (R3), no-progress (R5), token /
 * wall-clock budget (R6), hard (tool,args) denylist and the 5-rung
 * intervention ladder (loop-detect.ts). ENFORCEMENT - armed by default: without
 * the hard denylist the identical failing call was free to run again after the
 * streak guard reset, which is the "amnesiac failure" loop the audit flagged.
 * Disarm with RELIABILITY_LOOP_GUARD=0.
 */
export function reliabilityLoopGuardExtendedEnabled(): boolean {
  try {
    return enforcementEnabled("RELIABILITY_LOOP_GUARD");
  } catch {
    return false;
  }
}

/**
 * Phase 2 — exempt protected test/CI paths from the elevated approval tier
 * (see protected-paths.ts / risk-classifier.ts). Unlike every other flag this
 * one does NOT require the master switch: it is a user override of a safety
 * net, not an enforcement mechanism, and the protection it relaxes is on by
 * default because it is a bug fix (the pre-Phase-2 classifier auto-approved
 * test writes), not opt-in feature code. Default OFF = protection active.
 */
export function reliabilityProtectedWriteOverride(): boolean {
  try {
    return process.env.RELIABILITY_PROTECTED_WRITE_OVERRIDE === "1";
  } catch {
    return false;
  }
}

/**
 * Run the tamper detector (tamper-detector.ts) over the task's test-file diff.
 * A red gate pressures the model toward deleting or skipping tests; this is
 * the signal lane that calls that out. Requires the master switch.
 */
export function reliabilityTamperDetectionEnabled(): boolean {
  try {
    return reliabilityGatesEnabled() && process.env.RELIABILITY_TAMPER_DETECT === "1";
  } catch {
    return false;
  }
}

/**
 * Flake control: rerun failed tests within a budget and quarantine tests that
 * fail-then-pass (unstable), so a flake cannot burn repair rounds or fail a
 * gate that the code would actually pass. Requires the master switch.
 */
export function reliabilityFlakeControlEnabled(): boolean {
  try {
    return reliabilityGatesEnabled() && process.env.RELIABILITY_FLAKE_CONTROL === "1";
  } catch {
    return false;
  }
}

/**
 * Acceptance-first spec model (acceptance.ts): derive a structured acceptance
 * spec from the task text and track verified/failed/unverified items. Requires
 * the master switch.
 */
export function reliabilityAcceptanceSpecEnabled(): boolean {
  try {
    return reliabilityGatesEnabled() && process.env.RELIABILITY_ACCEPTANCE === "1";
  } catch {
    return false;
  }
}

/**
 * Phase 6 — durable memory & context: seeding the in-memory Failure Doctrine
 * from the durable failure ledger, enforcing flake quarantine from the durable
 * flake registry, and persisting compaction state across reloads. Requires the
 * master switch: these behaviours change what the model sees (doctrine seeds)
 * or what the gate does (quarantine skips), and they must stay inert until a
 * user opts in. Evidence collection (recording entries) stays unconditional —
 * collecting evidence never changes behaviour.
 */
export function reliabilityDurableMemoryEnabled(): boolean {
  try {
    return enforcementEnabled("RELIABILITY_DURABLE_MEMORY");
  } catch {
    return false;
  }
}

/**
 * Phase 3 — structured edit operations (edit-ops.ts, atomic-batch.ts,
 * path-jail.ts, tool-args.ts). Behind the master switch per the flags-header
 * rule: the EditOp surface is ADDITIONAL tooling (deviation D-3 — existing
 * write tools are untouched), and its dispatch wiring (apply_edit_ops,
 * validateToolArgs, assertSafeWrite at the write call sites) must stay inert
 * until both RELIABILITY_GATES=1 and RELIABILITY_EDIT_OPS=1 are set.
 */
export function reliabilityEditOpsEnabled(): boolean {
  try {
    return enforcementEnabled("RELIABILITY_EDIT_OPS");
  } catch {
    return false;
  }
}

/**
 * Phase 7 — the Verification Report wiring (verification-report.ts): computing
 * unverified[] + residualRisk and appending the human-readable report block at
 * task close. Requires the master switch like every other sub-flag — the
 * report must never appear for a user who did not opt in, and building it must
 * never be paid for when RELIABILITY_GATES is off. The rest of Phase 7
 * (reviewer panel, risk tiering, role stack) is gated separately by
 * reliabilityRolesReviewEnabled() so the review cost can be opted into
 * independently of the report.
 */
export function reliabilityVerificationReportEnabled(): boolean {
  try {
    return reliabilityGatesEnabled() && process.env.RELIABILITY_REPORT === "1";
  } catch {
    return false;
  }
}

/**
 * Phase 3 — the shared realpath path jail + write denylist (path-jail.ts).
 * Gates the wiring of assertSafeWrite / containPath at the write call sites
 * and the WRITE_TOOL_NAMES denylist enforcement. Behind the master switch per
 * the flags-header rule: turning it on without RELIABILITY_GATES=1 would put
 * path refusals into the tool loop while nothing in the pipeline can report
 * or repair them. OFF by default = byte-for-byte unchanged behaviour.
 */
export function reliabilityPathJailEnabled(): boolean {
  try {
    return enforcementEnabled("RELIABILITY_PATH_JAIL");
  } catch {
    return false;
  }
}

/**
 * Phase 4 — provenance labels + taint tracking (provenance.ts, and the taint
 * bookkeeping in capability-policy.ts / injection-scanner.ts relays). Gates
 * the maintenance of the taint ledger at the call sites: with the flag off
 * nothing marks, propagates, or consults taint and the task's provenance
 * labels are annotation-only. Behind the master switch per the flags-header
 * rule — refusals computed from a ledger nobody maintained would both block
 * legitimate work and report garbage.
 */
export function reliabilityProvenanceEnabled(): boolean {
  try {
    return reliabilityGatesEnabled() && process.env.RELIABILITY_TAINT === "1";
  } catch {
    return false;
  }
}

/**
 * Phase 4 — prompt-injection scanning (injection-scanner.ts). Gates the scan
 * over untrusted content entering LLM context (read_file bodies, fetched web
 * pages, command output) and the prose_tool escalation relay. Detection the
 * pipeline can annotate with is safe-by-default; the BLOCKING use of the
 * scan lives behind RELIABILITY_CAPABILITY_POLICY below, which must be
 * separately armed.
 */
export function reliabilityInjectionScanEnabled(): boolean {
  try {
    return reliabilityGatesEnabled() && process.env.RELIABILITY_INJECTION_SCAN === "1";
  } catch {
    return false;
  }
}

/**
 * Phase 4 — output scrubbing (scrubber.ts). Redacts secrets from tool output
 * (read_file bodies, command stdout) before they enter LLM context. Behind
 * the master switch per the flags-header rule: scrubbing changes what the
 * model sees, and a user who needs the verbatim bytes (e.g. debugging their
 * own .env fixture layout) should be able to read them.
 */
export function reliabilityScrubbingEnabled(): boolean {
  try {
    return reliabilityGatesEnabled() && process.env.RELIABILITY_SCRUB === "1";
  } catch {
    return false;
  }
}

/**
 * Phase 4 — the capability gate itself (capability-policy.ts: blocked /
 * requiresApproval decisions on tool calls from their provenance, the taint
 * ledger and the egress classifier). The strictest Phase 4 switch: this is
 * the one that turns detection into REFUSAL, so it needs its own explicit
 * opt-in on top of RELIABILITY_GATES and is OFF by default even for users
 * who arm the detectors.
 */
export function reliabilityCapabilityPolicyEnabled(): boolean {
  try {
    return reliabilityGatesEnabled() && process.env.RELIABILITY_CAPABILITY_POLICY === "1";
  } catch {
    return false;
  }
}
