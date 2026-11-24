// tool-text.ts — The single home for the small string/parse helpers that
// used to be copy-pasted across stream-reader.ts, useChatSession.ts,
// tool-handlers.ts and reflection-loop.ts (each copy drifting slightly).
// Everything here is pure — safe in Node, browser, and tests alike.

// === Word-level dedup (gpt-oss-120b "the the rule rule" pathology) ===

export function deduplicateWords(text: string): string {
  // Collapse "word word" → "word" (case-insensitive, word-boundary aware)
  // Two-pass handles triple+ duplicates: "a a a" → "a a" → "a"
  let prev: string;
  do {
    prev = text;
    text = text.replace(/(\b\w+\b)\s+\1\b/gi, "$1");
  } while (text !== prev);
  return text;
}

/**
 * Bounded per-chunk dedup window. Running deduplicateWords over the WHOLE
 * accumulated answer on every streamed chunk is O(n²) across a stream — on a
 * long reply that alone saturates the main thread and freezes every button
 * (including Stop) while the agent works. The pathology is ADJACENT repeated
 * words, so re-cleaning a bounded tail of the already-clean text together
 * with the new delta is behaviorally identical: pairs inside the delta, and
 * pairs straddling the (tail | delta) boundary, are re-examined; anything
 * earlier was already cleaned on a previous chunk. Final assembly still runs
 * a full dedupe before persisting, so saved output is unaffected.
 */
const DEDUPE_WINDOW_CHARS = 1200;

export function dedupeStreamedChunk(cleanSoFar: string, rawDelta: string): string {
  const tailStart = Math.max(0, cleanSoFar.length - DEDUPE_WINDOW_CHARS);
  return cleanSoFar.slice(0, tailStart) + deduplicateWords(cleanSoFar.slice(tailStart) + rawDelta);
}

// === Screenshot attach helpers (browser screenshots land inline in chat) ===

/**
 * Markdown image line the chat renderer turns into an inline <img> (with
 * download action). The data URL rides in the display transcript only — the
 * model gets the pixels through the vision channel, never this string.
 */
export function screenshotMarkdown(dataUrl: string, label: string): string {
  const safeLabel = (label || "screenshot").replace(/[\[\]]/g, "");
  return `\n![${safeLabel}](${dataUrl})\n`;
}

/**
 * Downscale a PNG/JPEG data URL to a max width so chat transcripts and
 * vision payloads stay light (a full-page capture can be megabytes).
 * Resolves to the ORIGINAL on any failure or outside a DOM — never throws,
 * so callers can always fall back to it.
 */
export function downscaleDataUrl(dataUrl: string, maxWidth = 1024): Promise<string> {
  try {
    if (typeof dataUrl !== "string" || !/^data:image\/(png|jpeg)/.test(dataUrl)) return Promise.resolve(dataUrl);
    if (typeof document === "undefined") return Promise.resolve(dataUrl);
    return new Promise((resolve) => {
      const done = (v: string) => resolve(v);
      try {
        const img = new Image();
        const timer = setTimeout(() => done(dataUrl), 8000);
        img.onload = () => {
          try {
            clearTimeout(timer);
            const w = (img as HTMLImageElement).naturalWidth || 0;
            if (!w || w <= maxWidth) return done(dataUrl);
            const scale = maxWidth / w;
            const canvas = document.createElement("canvas");
            canvas.width = maxWidth;
            canvas.height = Math.round(((img as HTMLImageElement).naturalHeight || 0) * scale) || 1;
            const ctx2d = canvas.getContext("2d");
            if (!ctx2d) return done(dataUrl);
            ctx2d.drawImage(img, 0, 0, canvas.width, canvas.height);
            done(canvas.toDataURL("image/png"));
          } catch {
            done(dataUrl);
          }
        };
        img.onerror = () => { clearTimeout(timer); done(dataUrl); };
        img.src = dataUrl;
      } catch {
        done(dataUrl);
      }
    });
  } catch {
    return Promise.resolve(dataUrl);
  }
}

// === XML tool-call parsing (legacy fallback for models without native tools) ===

export interface XmlToolCall {
  name: string;
  [key: string]: unknown;
}

// === Param-pair argument parsing (native-template fallback) ===============
// Some providers serve models whose chat template teaches arguments as
// param-key/param-value XML pairs instead of the JSON body the prompt
// requests (live-observed: a `read` call naming `filePath` for
// /workspace/terminal.js, streamed three times in one turn). JSON.parse on
// that shape throws, the call was silently dropped — nothing dispatched, the
// run ended "Stopped", and the raw markup leaked into the visible chat
// message while the model's prose claimed work had happened. These helpers
// parse that shape: as a non-JSON body inside the wrapper, and as bare
// (unwrapped) runs in prose.

/** One param_key/param_value pair, key first. Module-level regex — every
 *  caller resets lastIndex (the walks are synchronous, never re-entrant). */
const PARAM_PAIR_RE =
  /<param_key>([\s\S]*?)<\/param_key>[ \t\r\n]*<param_value>([\s\S]*?)<\/param_value>/g;

/** Closing-tag fragments and markup keywords are never tool names — a run
 *  that starts right after an unclosed wrapper has no resolvable name. */
const NOT_A_NAME_RE =
  /^(?:\/?param_(?:key|value)|\/?tool_call|\/?tool_result|\/?function_calls|\/?invoke|name)$/i;

/** The name token immediately preceding a param-pair run: a <name>foo</name>
 *  tag, or a bare identifier (read pairs glued to prose — dispatching under a
 *  guessed target would be worse than an honest parse failure. */
function paramNameBefore(before: string): string | null {
  const tag = before.match(/<name>[ \t]*([A-Za-z_][A-Za-z0-9_]{1,63})[ \t]*<\/name>[ \t\r\n]*$/);
  if (tag) return tag[1];
  const token = before.match(/(?:^|[\s>])[ \t]*([A-Za-z_][A-Za-z0-9_]{1,63})[ \t\r\n]*$/);
  if (!token || NOT_A_NAME_RE.test(token[1])) return null;
  return token[1];
}

/** Parse every maximal run of param pairs in `text` into tool calls. A run
 *  breaks at any non-whitespace gap (typically the next call's name token);
 *  runs with no resolvable name are skipped — they cannot dispatch. */
export function parseParamPairToolCalls(text: string): XmlToolCall[] {
  const calls: XmlToolCall[] = [];
  if (!text || !text.includes("<param_key>")) return calls;
  PARAM_PAIR_RE.lastIndex = 0;
  let pairs: Array<[string, string]> = [];
  let runStart = -1;
  let runEnd = -1;
  const flush = () => {
    if (runStart >= 0 && pairs.length > 0) {
      const name = paramNameBefore(text.slice(0, runStart));
      if (name) {
        const args: Record<string, string> = {};
        for (const [k, v] of pairs) {
          const key = k.trim();
          if (key) args[key] = v; // last write wins on duplicate keys
        }
        calls.push({ name, ...args });
      }
    }
    pairs = [];
    runStart = -1;
    runEnd = -1;
  };
  let m: RegExpExecArray | null;
  while ((m = PARAM_PAIR_RE.exec(text)) !== null) {
    if (runStart >= 0 && !/^[ \t\r\n]*$/.test(text.slice(runEnd, m.index))) flush();
    if (runStart < 0) runStart = m.index;
    runEnd = PARAM_PAIR_RE.lastIndex;
    pairs.push([m[1], m[2]]);
  }
  flush();
  return calls;
}

/** Remove param-pair markup (name token + pairs) from display text: the call
 *  either dispatched (its record is the status line / tool_result) or failed
 *  honestly — raw markup is never a message a user should read. */
export function stripParamPairMarkup(text: string): string {
  if (!text || !text.includes("<param_key>")) return text;
  PARAM_PAIR_RE.lastIndex = 0;
  const cuts: Array<[number, number]> = [];
  let runStart = -1;
  let runEnd = -1;
  const flush = () => {
    if (runStart >= 0 && runEnd > runStart) {
      let cutStart = runStart;
      const before = text.slice(0, runStart);
      const token = before.match(/(?:^|[\s>])[ \t]*([A-Za-z_][A-Za-z0-9_]{1,63})[ \t\r\n]*$/);
      if (token && !NOT_A_NAME_RE.test(token[1])) {
        const trailingWs = (before.match(/[ \t\r\n]*$/) || [""])[0].length;
        cutStart = runStart - token[1].length - trailingWs;
      } else {
        const tagBefore = before.match(/<name>[ \t]*[A-Za-z_][A-Za-z0-9_]{1,63}[ \t]*<\/name>[ \t\r\n]*$/);
        if (tagBefore) cutStart = runStart - tagBefore[0].length;
      }
      cuts.push([cutStart, runEnd]);
    }
    runStart = -1;
    runEnd = -1;
  };
  let m: RegExpExecArray | null;
  while ((m = PARAM_PAIR_RE.exec(text)) !== null) {
    if (runStart >= 0 && !/^[ \t\r\n]*$/.test(text.slice(runEnd, m.index))) flush();
    if (runStart < 0) runStart = m.index;
    runEnd = PARAM_PAIR_RE.lastIndex;
  }
  flush();
  if (cuts.length === 0) return text;
  cuts.sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [s, e] of cuts) out = out.slice(0, s) + out.slice(e);
  return out;
}

export function parseToolCalls(text: string): XmlToolCall[] {
  const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  const calls: XmlToolCall[] = [];
  const covered: Array<[number, number]> = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    covered.push([match.index, match.index + match[0].length]);
    try {
      calls.push(JSON.parse(match[1].trim()));
      continue;
    } catch {}
    // Not JSON: a native-template body of param_key/param_value pairs.
    // Dropping it silently is what made tools "break" — the call never ran
    // and the raw markup became the visible answer.
    const pairCalls = parseParamPairToolCalls(match[1]);
    if (pairCalls.length > 0) calls.push(...pairCalls);
    // else: skip malformed tool calls
  }
  // Bare (unwrapped) param-pair runs in prose — the same native-template
  // shape with the wrapper omitted. Closed blocks are masked out first so
  // their pairs are never parsed twice.
  if (text.includes("<param_key>")) {
    let masked = text;
    for (let i = covered.length - 1; i >= 0; i--) {
      const [s, e] = covered[i];
      masked = masked.slice(0, s) + " ".repeat(e - s) + masked.slice(e);
    }
    calls.push(...parseParamPairToolCalls(masked));
  }
  return calls;
}

// === Bare-JSON tool-call recovery ==========================================
// Weak OpenAI-compatible models sometimes drop the requested <tool_call> XML
// wrapper and emit a bare tool-call JSON object (or a JSON array of them),
// often fenced in ```json. If those shapes only parse as prose, the agent loop
// mistakes them for the final summary and ends the run one turn in
// (live-observed: `{"name":"read_file","path":"README.md"}`). Recovery is
// gated hard: the object must have a string "name" field, other keys must be
// plausible tool arguments, and prose around it must be thin (≤2 short
// non-brace lines) so real answers that merely contain JSON stay untouched.

const TOOL_CALL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/i;

/** Bounded argument value: scalars, small arrays and small nested objects.
 *  Tool args are usually flat, but MCP calls (arguments objects), batch
 *  variants and edit lists are NOT — rejecting them meant a perfectly valid
 *  tool call was treated as prose and the model got no tool at all. */
function isBoundedArgValue(value: unknown, depth = 0): boolean {
  if (value === null) return true;
  if (typeof value === "string") return value.length <= 20_000;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (depth >= 2) return false;
  if (Array.isArray(value)) {
    return value.length <= 50 && value.every((v) => isBoundedArgValue(v, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length <= 30 && entries.every(([, v]) => isBoundedArgValue(v, depth + 1));
  }
  return false;
}

/**
 * Tool names that free models invent for the ONE command tool we ship.
 * Canonical roster name is `run_command`; the models write `terminal`,
 * `bash`, `shell`, `run_terminal_cmd`, `execute_command`… Converting is the
 * difference between "the agent works" and "the raw JSON becomes the answer".
 */
const COMMAND_TOOL_ALIASES = new Set([
  "terminal",
  "bash",
  "shell",
  "sh",
  "cmd",
  "run_terminal",
  "run_terminal_cmd",
  "run_shell",
  "run_bash",
  "execute_command",
  "exec",
  "run",
]);

/** Parameter names models use for the command string itself. */
const COMMAND_PARAM_ALIASES = ["cmd", "command", "shell_command", "script", "input", "code"];

/** Normalize a recovered call to `{ name, ...args }` with a real tool name. */
function normalizeToolCall(rec: Record<string, unknown>): (Record<string, unknown> & { name: string }) | null {
  // Shape A: { tool: "terminal", args: {...} } / { name, arguments }
  const container = rec.args ?? rec.arguments ?? rec.parameters ?? rec.input;
  if (typeof rec.tool === "string" || (typeof rec.name === "string" && isPlainObject(container))) {
    const rawName = (typeof rec.name === "string" ? rec.name : rec.tool) as string;
    if (!TOOL_CALL_NAME_RE.test(rawName)) return null;
    const args = isPlainObject(container) ? (container as Record<string, unknown>) : {};
    const merged: Record<string, unknown> = { ...args };
    for (const [k, v] of Object.entries(rec)) {
      if (["tool", "name", "args", "arguments", "parameters", "input"].includes(k)) continue;
      merged[k] = v;
    }
    return withCanonicalName(rawName, merged);
  }
  // Shape B: { name: "read_file", path: "…" }
  if (typeof rec.name === "string" && TOOL_CALL_NAME_RE.test(rec.name)) {
    const { name, ...args } = rec;
    return withCanonicalName(name as string, args as Record<string, unknown>);
  }
  // Shape C: a bare command object — { cmd: "ls -la", cwd: "/workspace" }.
  // Only accepted when EVERY key is a command-tool parameter and one of them
  // carries a string command; otherwise prose JSON would become an exec.
  const keys = Object.keys(rec);
  if (keys.length >= 1 && keys.length <= 5) {
    const args: Record<string, unknown> = {};
    let command: string | null = null;
    for (const [k, v] of Object.entries(rec)) {
      if (!["cmd", "command", "cwd", "timeout", "shell"].includes(k)) return null;
      if ((k === "cmd" || k === "command") && typeof v === "string" && v.trim()) command = v;
      args[k === "cmd" ? "command" : k] = v;
    }
    if (!command) return null;
    return { name: "run_command", ...args, command };
  }
  return null;
}

function isPlainObject(v: unknown): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Map an invented name + its args onto the roster's canonical name/params. */
function withCanonicalName(name: string, args: Record<string, unknown>): Record<string, unknown> & { name: string } | null {
  const lower = name.toLowerCase();
  if (!COMMAND_TOOL_ALIASES.has(lower)) return { name, ...args } as Record<string, unknown> & { name: string };
  const out: Record<string, unknown> = { name: "run_command" };
  let command: string | null = null;
  for (const [k, v] of Object.entries(args)) {
    const key = k.toLowerCase();
    if (COMMAND_PARAM_ALIASES.includes(key)) {
      if (typeof v === "string" && v.trim()) command = v;
      continue;
    }
    out[k === "cwd" ? "cwd" : k] = v;
  }
  if (!command) return null; // a command tool with no command is not a call
  out.command = command;
  return out as Record<string, unknown> & { name: string };
}

/** A tool-call-shaped object: string "name" matching tool-name shape, only
 *  bounded argument values, bounded key count. */
function isToolCallShaped(obj: unknown): obj is Record<string, unknown> & { name: string } {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const rec = obj as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length < 1 || keys.length > 20) return false;
  for (const [k, v] of Object.entries(rec)) {
    if (k === "name" || k === "tool" || k === "args" || k === "arguments" || k === "parameters" || k === "input") continue;
    if (!isBoundedArgValue(v)) return false;
  }
  return normalizeToolCall(rec) !== null;
}

/**
 * Every balanced `{…}` span in the text, in order. A model that emits two
 * calls in one turn writes them back to back (`{...} {...}`) — the old
 * first-brace-to-last-brace span is then invalid JSON and EVERY call was
 * dropped, so the raw objects were printed as the answer instead.
 */
function balancedObjectSpans(text: string): Array<{ text: string; start: number; end: number }> {
  const spans: Array<{ text: string; start: number; end: number }> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) spans.push({ text: text.slice(start, i + 1), start, end: i + 1 });
      }
    }
  }
  return spans;
}

/**
 * Extract tool-call-shaped JSON from a model turn that skipped the XML
 * wrapper, and REMOVE the spans that were understood.
 *
 * Returns the calls plus the residue a user should actually see: raw
 * `{"tool":"terminal","args":{...}}` in the answer bubble is a bug report, not
 * an answer (live-observed: the transcript showed the JSON instead of the
 * result of listing files).
 *
 * Never returns XML results twice — callers feed this only the residue after
 * XML parsing.
 */
export function extractBareJsonToolCalls(text: string): { calls: XmlToolCall[]; cleaned: string } {
  const empty = { calls: [] as XmlToolCall[], cleaned: text };
  if (!text || !text.includes('"')) return empty;

  const trimmed = text.trim();
  // XML-wrapped spans belong to the XML parser (even if its JSON was
  // malformed) and fenced blocks are scanned separately — mask both so the raw
  // scan and the prose gate only see genuine bare-JSON residue.
  const maskedForScan = trimmed
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, (m) => " ".repeat(m.length))
    .replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length));

  type Hit = { call: XmlToolCall; start: number; end: number };
  const hits: Hit[] = [];

  // 1. json-fenced block(s) — parsed from the ORIGINAL text
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(trimmed)) !== null) {
    const body = m[1].trim();
    if (!body.includes('"')) continue;
    const bodyStart = m.index + m[0].indexOf(body);
    for (const span of balancedObjectSpans(body)) {
      const parsed = parseOneCall(span.text);
      if (parsed) hits.push({ call: parsed, start: bodyStart + span.start, end: bodyStart + span.end });
    }
  }

  // 2. bare objects anywhere in the residue — every balanced span, in order
  for (const span of balancedObjectSpans(maskedForScan)) {
    const parsed = parseOneCall(span.text);
    if (parsed) hits.push({ call: parsed, start: span.start, end: span.end });
  }

  if (hits.length === 0) return empty;
  if (hits.length > 8) return empty; // not a tool turn, something runaway

  // Thin-prose gate: with every understood span removed, at most 2 short lines
  // of chatter may remain ("Reading the file:"). A real answer paragraph means
  // the JSON was data, not a call, and is left alone.
  let cleaned = trimmed;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    cleaned = cleaned.slice(0, h.start) + cleaned.slice(h.end);
  }
  const outsideLines = cleaned.replace(/[ \t]+/g, " ").split("\n").filter((l) => l.trim().length > 0);
  if (outsideLines.length > 2 || outsideLines.some((l) => l.length > 120)) return empty;

  const seen = new Set<string>();
  const calls: XmlToolCall[] = [];
  for (const h of hits) {
    const key = JSON.stringify(h.call);
    if (!seen.has(key)) {
      seen.add(key);
      calls.push(h.call);
    }
  }
  return { calls, cleaned: cleaned.trim() };
}

/** Parse one balanced JSON object into a normalized tool call, or null. */
function parseOneCall(raw: string): XmlToolCall | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = Array.isArray(obj) ? obj : [obj];
  if (list.length === 0 || list.length > 8) return null;
  const normalized = list.map((o) => (isToolCallShaped(o) ? normalizeToolCall(o as Record<string, unknown>) : null));
  if (normalized.some((n) => n === null)) return null;
  const first = normalized[0] as Record<string, unknown> & { name: string };
  return first as unknown as XmlToolCall;
}

/** Back-compat single-call view used by the loop engine's recovery hook. */
export function parseBareJsonToolCalls(text: string): XmlToolCall[] {
  return extractBareJsonToolCalls(text).calls;
}

// === Status-line replacement (agent display transcript) ===

/** Replace the last status line ("analysing [x]") with a result line. */
export function replaceLastStatus(display: string, resultLine: string): string {
  const statusRegex = /^(analysing|reading|writing|listing|thinking)\s+\[[^\]]+\]\n?$/m;
  const lines = display.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (statusRegex.test(lines[i])) {
      lines[i] = resultLine;
      return lines.join("\n");
    }
  }
  return display + resultLine + "\n";
}

// === File-tree helpers ===

interface TreeNodeLike {
  kind: string;
  path: string;
  children?: TreeNodeLike[];
}

/** Get all file paths under a directory prefix (or the whole tree). */
export function listFilesUnderPath(path: string, nodes: TreeNodeLike[]): string {
  const results: string[] = [];
  const walk = (ns: TreeNodeLike[]) => {
    for (const n of ns) {
      if (n.kind === "file" && (path === "" || path === "." || n.path.startsWith(path))) {
        results.push(n.path);
      }
      if (n.kind === "directory" && n.children) walk(n.children);
    }
  };
  walk(nodes);
  return results.length > 0 ? results.join("\n") : "No files found at that path.";
}

/** Substring search over cached file contents. Returns `path:line: text` rows. */
export function searchCodeInContents(
  query: string,
  fileContents: Record<string, string>,
  maxResults = 20
): string {
  const results: string[] = [];
  for (const [filePath, content] of Object.entries(fileContents)) {
    if (results.length >= maxResults) break;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(query.toLowerCase())) {
        results.push(`${filePath}:${i + 1}: ${lines[i].trim()}`);
        if (results.length >= maxResults) break;
      }
    }
  }
  return results.length > 0 ? results.join("\n") : `No matches found for "${query}"`;
}
