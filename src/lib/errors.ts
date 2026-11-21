// errors.ts — typed failures for hosts that need to branch on WHY.
//
// 0.3.x threw plain `Error`s with prose, so every caller matched on message
// text (`/401|403/`, `/timed out/`) — which silently breaks the moment wording
// changes, and cannot distinguish "retry will help" from "the user must act".
// The codes below are stable identifiers; messages stay human-readable and are
// still what a model sees in a tool_result.

export type SdkErrorCode =
  | "MCP_SPAWN_FAILED"
  | "MCP_TIMEOUT"
  | "MCP_CRASHED"
  | "MCP_NOT_CONFIGURED"
  | "MCP_LIMIT_REACHED"
  | "MCP_NEEDS_REAUTH"
  | "MCP_INVALID_ARGS"
  | "MCP_ENV_SCOPE"
  | "MARKETPLACE_UNVERIFIED"
  | "MARKETPLACE_SCHEMA";

const RETRYABLE: ReadonlySet<SdkErrorCode> = new Set<SdkErrorCode>([
  "MCP_TIMEOUT",
  "MCP_CRASHED",
  "MARKETPLACE_UNVERIFIED", // a re-fetch may succeed
]);

export interface SdkErrorInfo {
  code: SdkErrorCode;
  /** What the caller/model should do about it, in one clause. */
  hint?: string;
  cause?: unknown;
  /** Structured context (failed field names, server id…) for logs and tests. */
  details?: Record<string, unknown>;
}

export class SdkError extends Error {
  readonly code: SdkErrorCode;
  readonly retryable: boolean;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: SdkErrorCode, message: string, info: Omit<SdkErrorInfo, "code"> = {}) {
    super(message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = "SdkError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.hint = info.hint;
    this.details = info.details;
  }

  /** One line for a tool_result: message plus the actionable hint. */
  toToolText(): string {
    return this.hint ? `${this.message} — ${this.hint}` : this.message;
  }
}

/** Type guard for hosts that receive errors across an IPC/bridge boundary. */
export function isSdkError(err: unknown): err is SdkError {
  return err instanceof SdkError || (typeof err === "object" && err !== null && (err as { name?: string }).name === "SdkError");
}

/** Coerce anything thrown into a code-bearing error. */
export function toSdkError(err: unknown, fallback: SdkErrorCode = "MCP_CRASHED"): SdkError {
  if (err instanceof SdkError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new SdkError(fallback, message, { cause: err });
}
