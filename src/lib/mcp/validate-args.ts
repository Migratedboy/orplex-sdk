// validate-args.ts — check a tool call against the tool's own JSON schema.
//
// Why bother when the server validates anyway: a marketplace server that
// rejects bad arguments does it with its own dialect, in its own words, and
// often *after* the side effect it guards against has partially happened. The
// model then retries blind. Catching the obvious mistakes locally turns a
// 30-second round trip into a one-line correction the model can act on.
//
// Scope is deliberately small — the draft-07 keywords that appear in real MCP
// tool schemas: type, required, properties, additionalProperties, enum, const,
// items, min/max for numbers, minLength/maxLength/pattern for strings, and
// minItems/maxItems. Anything else is ignored rather than guessed at, because a
// false rejection is worse than a missing check: it would refuse a call the
// server would have accepted.
//
// No dependencies. The SDK's promise is that it installs into an Electron
// bundle without dragging a JSON-Schema engine behind it.

export type JsonSchema = Record<string, unknown>;

export interface ValidationResult {
  ok: boolean;
  /** Human-readable problems, one per line, phrased for the model to fix. */
  errors: string[];
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  if (type === "integer") return actual === "integer";
  return actual === type;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate `value` against `schema`. Returns every problem it finds (not just
 * the first): the model fixes more in one turn that way.
 */
export function validateValue(value: unknown, schema: JsonSchema, path = ""): string[] {
  const errors: string[] = [];
  const at = path || "(root)";

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type.map(String) : [String(schema.type)];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${at}: expected ${types.join(" or ")}, got ${typeOf(value)}`);
      return errors; // a wrong type makes deeper checks noise
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${at}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === "string") {
    const len = [...value].length;
    if (typeof schema.minLength === "number" && len < schema.minLength) {
      errors.push(`${at}: shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && len > schema.maxLength) {
      errors.push(`${at}: longer than maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string") {
      // Guard against ReDoS: cap pattern/value sizes and reject nested-quantifier
      // shapes that are the usual catastrophic-backtracking triggers.
      const pattern = schema.pattern;
      if (pattern.length > 500 || value.length > 10000 || /\\([^)]*[+*][^)]*\\)[+*{]/.test(pattern)) {
        /* treat as "no constraint" rather than hanging the agent loop */
      } else {
        try {
          if (!new RegExp(pattern).test(value)) errors.push(`${at}: does not match pattern ${pattern}`);
        } catch {
          /* an unparseable pattern is the server's bug, not the caller's */
        }
      }
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${at}: must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${at}: must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${at}: needs at least ${schema.minItems} item(s)`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${at}: allows at most ${schema.maxItems} item(s)`);
    }
    if (isPlainObject(schema.items)) {
      value.forEach((item, i) => errors.push(...validateValue(item, schema.items as JsonSchema, `${path}[${i}]`)));
    }
  }

  if (isPlainObject(value)) {
    const props = isPlainObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const key of required) {
      if (value[key] === undefined) errors.push(`${at}.${key}: required`);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (value[key] !== undefined && isPlainObject(sub)) {
        errors.push(...validateValue(value[key], sub, path ? `${path}.${key}` : key));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${at}.${key}: not an accepted argument`);
      }
    }
  }

  return errors;
}

/** Validate a tool-call argument bag. Missing/empty schemas always pass. */
export function validateToolArgs(schema: unknown, args: Record<string, unknown>): ValidationResult {
  if (!isPlainObject(schema) || Object.keys(schema).length === 0) return { ok: true, errors: [] };
  // A schema with no `type` and no properties constrains nothing.
  if (schema.type === undefined && !isPlainObject(schema.properties) && !Array.isArray(schema.required)) {
    return { ok: true, errors: [] };
  }
  const errors = validateValue(args, schema as JsonSchema);
  return { ok: errors.length === 0, errors };
}
