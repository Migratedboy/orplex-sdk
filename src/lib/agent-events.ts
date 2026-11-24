// agent-events.ts — Status emission and event system for agent progress display
// Emits structured events that the frontend subscribes to for real-time progress

// === Status step and activity types ===

export type StatusStep = {
  type: "step";
  agent: string;
  label: string;
  status: "pending" | "active" | "done" | "error";
  detail?: string;
};

export type StatusActivity = {
  type: "activity";
  entry: { timestamp: number; type: string; message: string; agent?: string };
};

export type StatusEvent = StatusStep | StatusActivity;

/**
 * Context compaction — the transcript was summarized to stay under budget.
 *
 * Deliberately a STRUCTURED event rather than a status string: a compaction
 * has numbers worth showing (before → after) and a marker worth rendering,
 * and neither survives being flattened into "Context compacted — earlier
 * turns summarized…". The chat timeline renders a collapsible divider for it.
 */
export type StatusCompaction = {
  type: "compaction";
  tokensBefore: number;
  tokensAfter: number;
  mode: "automatic" | "manual";
  summary?: string;
};

/**
 * Lifecycle of one tool call. A UI row is expected to exist from `pending`
 * through the terminal state, and to be REMOVED only on `dismissed` (which
 * means "the parsed transcript owns this row now").
 *
 * `running | dismissed` was the original pair, and it was not enough to draw a
 * call: there was no way to say "this finished", so a live row could not settle
 * and the only way to stop a spinner was to delete the row at the moment the
 * tool STARTED executing. That is what made tool calls appear all at once, in
 * their final state. The two extra terminal states and the timestamps below are
 * what a row needs to animate pending → running → done.
 */
export type ToolLifecycleStatus = "pending" | "running" | "done" | "error" | "dismissed";

export type StatusLiveToolCall = {
  type: "live-tool-call";
  taskId: string;
  id: string;
  tool: string;
  args: Record<string, unknown>;
  status: ToolLifecycleStatus;
  /** Epoch ms — when the call began (set on `pending`/`running`). */
  startedAt?: number;
  /** Epoch ms — when it settled (set on `done`/`error`). */
  endedAt?: number;
  /** Result text for the row's expandable body (`done`). */
  output?: string;
};

export type StatusMessage = StatusEvent | StatusCompaction | StatusLiveToolCall;

const liveToolStartedAt = new Map<string, number>();

/** Statuses after which a call will never report again. */
const TERMINAL_LIFECYCLE = new Set<ToolLifecycleStatus>(["done", "error", "dismissed"]);

export function emitLiveToolCall(
  event: Omit<StatusLiveToolCall, "type" | "startedAt"> & { startedAt?: number; endedAt?: number }
) {
  const reusable = event.status === "pending" || event.status === "running";
  // The FIRST start wins: a provider retry re-announces the same call and must
  // not reset a timer the user is already watching.
  const startedAt = reusable
    ? liveToolStartedAt.get(event.id) ?? event.startedAt ?? Date.now()
    : event.startedAt ?? liveToolStartedAt.get(event.id);
  if (reusable && startedAt) liveToolStartedAt.set(event.id, startedAt);
  emitStatus({ type: "live-tool-call", ...event, ...(startedAt ? { startedAt } : {}) });
  // Terminal states release the map entry. `dismissed` used to be the only
  // cleanup, so every finished call leaked an entry for the life of the page.
  if (TERMINAL_LIFECYCLE.has(event.status)) liveToolStartedAt.delete(event.id);
}

/**
 * Emit a compaction event. Best-effort by design: a listener that throws is
 * swallowed so a UI subscriber can never break the agent loop that compacted.
 */
export function emitCompaction(payload: Omit<StatusCompaction, "type">) {
  for (const listener of _statusListeners) {
    try {
      listener({ type: "compaction", ...payload });
    } catch {}
  }
}

// === Status listeners ===

let _statusListeners: Array<(event: StatusMessage) => void> = [];

export function onAgentStatus(listener: (event: StatusMessage) => void): () => void {
  _statusListeners.push(listener);
  return () => {
    _statusListeners = _statusListeners.filter((l) => l !== listener);
  };
}

export function emitStatus(event: StatusMessage) {
  for (const listener of _statusListeners) {
    try {
      listener(event);
    } catch {}
  }
}

export function emitActivity(entry: {
  type: string;
  message: string;
  agent?: string;
}) {
  emitStatus({
    type: "activity",
    entry: { ...entry, timestamp: Date.now() },
  });
}

// === Live preview events ===
// The agent can drive the user's Preview panel. preview_browser and
// take_screenshot emit here; the RightPanel PreviewTab listens and navigates
// its live iframe — turning static screenshots into an embedded browser.

export interface PreviewEvent {
  url: string;
  source: "preview_browser" | "take_screenshot" | "verify_app";
  timestamp: number;
}

let _previewListeners: Array<(event: PreviewEvent) => void> = [];

/** How long an unheard preview event stays available for the first subscriber. */
const UNHEARD_PREVIEW_TTL_MS = 10_000;

/**
 * A preview event nobody was around to hear — the right panel can be closed
 * (or still mounting) when the agent navigates. Handed to the first listener
 * that subscribes, but only while fresh, so a stale URL can never hijack the
 * panel later.
 */
let _unheardPreview: PreviewEvent | null = null;

export function onPreviewEvent(
  listener: (event: PreviewEvent) => void
): () => void {
  _previewListeners.push(listener);
  const unheard = _unheardPreview;
  if (unheard) {
    _unheardPreview = null;
    if (Date.now() - unheard.timestamp <= UNHEARD_PREVIEW_TTL_MS) {
      // Next tick: the subscriber's own layout effects (viewport bounds, tab
      // visibility) must have run before we navigate, or the view is briefly
      // positioned at the main process's fallback rect.
      setTimeout(() => {
        try {
          listener(unheard);
        } catch {}
      }, 0);
    }
  }
  return () => {
    _previewListeners = _previewListeners.filter((l) => l !== listener);
  };
}

export function emitPreview(url: string, source: PreviewEvent["source"]) {
  const event: PreviewEvent = { url, source, timestamp: Date.now() };
  _unheardPreview = _previewListeners.length === 0 ? event : null;
  for (const listener of _previewListeners) {
    try {
      listener(event);
    } catch {}
  }
}
