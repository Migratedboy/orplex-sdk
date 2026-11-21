// marketplace — resolve + verify the Orplex marketplace catalog.
//
// The app never trusts a catalog blob: the index carries an Ed25519 signature
// over its canonical JSON, and every item carries a sha256 of its own files.
// Anything unsigned or mismatched is dropped, not "warned about" — a catalog
// decides which MCP servers an agent may launch.
//
// Framework-free: fetch, cache and crypto are all injected or node-native, so
// the same resolver runs in the desktop app, a server, or a CLI.

import { createHash, verify as edVerify, createPublicKey } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type MarketplaceKind = "mcp" | "skill" | "plugin";

export interface MarketplaceItem {
  id: string;
  kind: MarketplaceKind;
  version: string;
  /** Semver range of the CONSUMING SDK/app, e.g. ">=2.0.0 <3". */
  engine?: string;
  path: string;
  sha256: string;
  /**
   * Digest construction used for `sha256`.
   *   "v1" (absent) — sha256 of `${name}\n${content}` joined by "\n". Ambiguous:
   *        a file whose content contains a name-shaped line can shift the
   *        boundary between two files without changing the digest.
   *   "v2" — sha256 over per-file sha256 of `name + NUL + content`, joined by
   *        "\n". Length-free but unambiguous: the NUL cannot occur in a file
   *        name, so the split point is always well defined.
   */
  digest?: "v1" | "v2";
  size?: number;
  tags?: string[];
  auth?: "oauth" | "token" | "none";
  description?: string;
}

export interface MarketplaceIndex {
  schemaVersion: number;
  generatedAt: string;
  minAppVersion?: string | null;
  items: MarketplaceItem[];
  /** Monotonic publish counter — a replayed older index has a lower seq. */
  seq?: number;
  /** ISO timestamp after which this index must not be trusted. */
  expiresAt?: string | null;
  /** Item ids withdrawn by the publisher; filtered out even if still listed. */
  revoked?: string[];
  /** Signing key id, so a rotation does not require a new app build. */
  keyId?: string;
  /** Additional verification keys, base64url SPKI DER, keyed by id. */
  keys?: Array<{ keyId: string; publicKey: string }>;
  /** Base64url Ed25519 signature over canonicalJson(index without signature). */
  signature?: string | null;
}

/** Index schema versions this SDK understands. Anything newer is refused. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1, 2];

export function isSupportedSchema(index: MarketplaceIndex): boolean {
  return SUPPORTED_SCHEMA_VERSIONS.includes(index.schemaVersion);
}

export interface FetchIndexOptions {
  url?: string;
  /** Previous ETag — the server answers 304 and we keep the cached index. */
  etag?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface FetchIndexResult {
  index: MarketplaceIndex | null;
  etag: string | null;
  notModified: boolean;
  error?: string;
}

export const DEFAULT_INDEX_URL =
  "https://raw.githubusercontent.com/Migratedboy/orplex-marketplace/main/catalog/index.json";

/** Deterministic JSON (sorted keys, recursively) — signatures must not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Verify the index signature. `publicKey` accepts base64url SPKI DER (the same
 * encoding the Orplex session keys use) or a PEM string.
 * Returns false on any parse/verify failure — never throws.
 */
export function verifyIndex(index: MarketplaceIndex, publicKey: string): boolean {
  const signature = index.signature;
  if (!signature) return false;
  try {
    const { signature: _omit, ...payload } = index;
    const key = publicKey.includes("BEGIN PUBLIC KEY")
      ? createPublicKey(publicKey)
      : createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
    return edVerify(
      null,
      Buffer.from(canonicalJson(payload), "utf8"),
      key,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

/** Fetch the index with ETag revalidation, a hard timeout and no throwing. */
export async function fetchIndex(options: FetchIndexOptions = {}): Promise<FetchIndexResult> {
  const url = options.url || DEFAULT_INDEX_URL;
  const timeoutMs = options.timeoutMs ?? 3000;
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(options.etag ? { "if-none-match": options.etag } : {}),
      },
    });
    if (res.status === 304) {
      return { index: null, etag: options.etag ?? null, notModified: true };
    }
    if (!res.ok) {
      return { index: null, etag: null, notModified: false, error: `HTTP ${res.status}` };
    }
    const raw = await res.text();
    const parsed = JSON.parse(raw) as MarketplaceIndex;
    if (!parsed || !Array.isArray(parsed.items)) {
      return { index: null, etag: null, notModified: false, error: "malformed index" };
    }
    return { index: parsed, etag: res.headers.get("etag"), notModified: false };
  } catch (err) {
    return {
      index: null,
      etag: null,
      notModified: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ semver (tiny) ----------------------------- */

function parseVersion(v: string): [number, number, number] {
  const [maj = "0", min = "0", pat = "0"] = v.replace(/^v/, "").split("-")[0].split(".");
  return [Number(maj) || 0, Number(min) || 0, Number(pat) || 0];
}

function cmp(a: string, b: string): number {
  const [a1, a2, a3] = parseVersion(a);
  const [b1, b2, b3] = parseVersion(b);
  return a1 - b1 || a2 - b2 || a3 - b3;
}

/**
 * Deliberately minimal range support — `>=1.2.3 <3`, `^2.1.0`, `~2.1.0`, `2.x`,
 * `*`. Dependency-free on purpose: a five-line comparator beats shipping
 * `semver` into an Electron bundle for a four-token range.
 */
export function satisfiesRange(version: string, range?: string | null): boolean {
  if (!range || range === "*" || range === "latest") return true;
  const clauses = range.trim().split(/\s+/);
  return clauses.every((clause) => {
    if (clause.startsWith("^")) {
      const base = clause.slice(1);
      const [maj] = parseVersion(base);
      return cmp(version, base) >= 0 && cmp(version, `${maj + 1}.0.0`) < 0;
    }
    if (clause.startsWith("~")) {
      const base = clause.slice(1);
      const [maj, min] = parseVersion(base);
      return cmp(version, base) >= 0 && cmp(version, `${maj}.${min + 1}.0`) < 0;
    }
    if (clause.startsWith(">=")) return cmp(version, clause.slice(2)) >= 0;
    if (clause.startsWith(">")) return cmp(version, clause.slice(1)) > 0;
    if (clause.startsWith("<=")) return cmp(version, clause.slice(2)) <= 0;
    if (clause.startsWith("<")) return cmp(version, clause.slice(1)) < 0;
    if (/^[0-9]+\.x$/.test(clause)) {
      return (
        cmp(version, clause.replace("x", "0")) >= 0 &&
        cmp(version, `${Number(clause.split(".")[0]) + 1}.0.0`) < 0
      );
    }
    return cmp(version, clause) === 0;
  });
}

export interface ResolveOptions {
  /** Version of the consuming app/SDK — items whose `engine` excludes it are dropped. */
  appVersion: string;
  kinds?: MarketplaceKind[];
}

/** Filter an index down to what this app version can actually run. */
export function resolveCatalog(index: MarketplaceIndex, options: ResolveOptions): MarketplaceItem[] {
  const kinds = options.kinds ? new Set(options.kinds) : null;
  const revoked = new Set(index.revoked ?? []);
  return index.items.filter(
    (item) =>
      !revoked.has(item.id) &&
      (!kinds || kinds.has(item.kind)) &&
      satisfiesRange(options.appVersion, item.engine) &&
      (!index.minAppVersion || satisfiesRange(options.appVersion, `>=${index.minAppVersion}`)),
  );
}

/**
 * Everything that must be true before an index is usable.
 *
 * Signature alone is not enough: a validly signed old index can be replayed to
 * pin installs to a content set the publisher has since replaced or withdrawn
 * (an item with a known-bad MCP server, say). `seq` and `expiresAt` are the
 * publisher's way of saying "this is no longer current"; both are optional so
 * schemaVersion 1 indexes keep working.
 */
export interface IndexVerdict {
  ok: boolean;
  reason?: "schema" | "expired" | "signature" | "missing-key";
}

export function checkIndex(
  index: MarketplaceIndex,
  options: { publicKey?: string | null; now?: () => number } = {},
): IndexVerdict {
  if (!isSupportedSchema(index)) return { ok: false, reason: "schema" };
  if (index.expiresAt) {
    const at = Date.parse(index.expiresAt);
    const now = options.now ? options.now() : Date.now();
    if (Number.isFinite(at) && at < now) return { ok: false, reason: "expired" };
  }
  if (!options.publicKey) return { ok: false, reason: "missing-key" };
  // Rotation: prefer the key named by keyId when the index carries a keyring,
  // and fall back to the pinned host key so a v1 index still verifies.
  const candidates: string[] = [];
  if (index.keys?.length) {
    const named = index.keyId ? index.keys.find((k) => k.keyId === index.keyId) : undefined;
    if (named) candidates.push(named.publicKey);
    else candidates.push(...index.keys.map((k) => k.publicKey));
  }
  candidates.push(options.publicKey);
  return candidates.some((key) => verifyIndex(index, key)) ? { ok: true } : { ok: false, reason: "signature" };
}

/* --------------------------------- cache --------------------------------- */

export interface CacheEntry {
  etag: string | null;
  fetchedAt: number;
  index: MarketplaceIndex;
}

export interface MarketplaceCache {
  read(): Promise<CacheEntry | null>;
  write(entry: CacheEntry): Promise<void>;
}

/** File-backed cache — one JSON file, atomic-ish write, never throws on read. */
export function createFileCache(dir: string, file = "marketplace-index.json"): MarketplaceCache {
  const target = path.join(dir, file);
  return {
    async read() {
      try {
        return JSON.parse(await readFile(target, "utf8")) as CacheEntry;
      } catch {
        return null;
      }
    },
    async write(entry) {
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(target, JSON.stringify(entry), "utf8");
      } catch {
        /* a cache miss is survivable; never break boot over it */
      }
    },
  };
}

export interface LoadCatalogOptions extends ResolveOptions {
  url?: string;
  cache?: MarketplaceCache;
  publicKey?: string | null;
  timeoutMs?: number;
  /** Fresh for this long before revalidating. */
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  seed?: MarketplaceIndex | null;
}

export interface LoadCatalogResult {
  items: MarketplaceItem[];
  source: "network" | "cache" | "seed";
  error?: string;
  verified: boolean;
}

/**
 * Fallback chain: revalidate network → cached index → caller-supplied seed.
 * A missing/unsigned index degrades to the seed instead of an empty toolbox,
 * because an empty toolbox looks like "the product is broken" to a user.
 */
export async function loadCatalog(options: LoadCatalogOptions): Promise<LoadCatalogResult> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 12 * 60 * 60 * 1000;
  const cached = options.cache ? await options.cache.read() : null;
  const fresh = cached && now() - cached.fetchedAt < ttlMs;
  // One predicate for every source: schema, expiry, signature. A cache entry
  // that has since expired falls through to the network instead of being
  // served because it was once good.
  const check = (index: MarketplaceIndex) =>
    checkIndex(index, { publicKey: options.publicKey, now }).ok;

  if (fresh && check(cached!.index)) {
    return { items: resolveCatalog(cached!.index, options), source: "cache", verified: true };
  }

  const fetched = await fetchIndex({
    url: options.url,
    etag: cached?.etag ?? null,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });

  if (fetched.index) {
    if (check(fetched.index)) {
      await options.cache?.write({ etag: fetched.etag, fetchedAt: now(), index: fetched.index });
      return { items: resolveCatalog(fetched.index, options), source: "network", verified: true };
    }
    if (cached && check(cached.index)) {
      return {
        items: resolveCatalog(cached.index, options),
        source: "cache",
        verified: true,
        error: "index signature rejected",
      };
    }
    return {
      items: options.seed ? resolveCatalog(options.seed, options) : [],
      source: options.seed ? "seed" : "seed",
      verified: false,
      error: "index signature rejected",
    };
  }

  if (fetched.notModified && cached && check(cached.index)) {
    await options.cache?.write({ ...cached, fetchedAt: now() });
    return { items: resolveCatalog(cached.index, options), source: "cache", verified: true };
  }

  if (cached && check(cached.index)) {
    return {
      items: resolveCatalog(cached.index, options),
      source: "cache",
      verified: true,
      error: fetched.error,
    };
  }
  return {
    items: options.seed ? resolveCatalog(options.seed, options) : [],
    source: "seed",
    verified: false,
    error: fetched.error,
  };
}

/** Verify an item's files against the sha256 recorded in the index. */
export function verifyItemFiles(item: MarketplaceItem, files: Record<string, string>): boolean {
  const names = Object.keys(files).sort();
  if (!names.length) return false;
  return itemDigest(files, item.digest ?? "v1") === item.sha256;
}

/**
 * The two digest constructors, kept side by side so the marketplace's
 * build-index.mjs can be diffed against this file line for line.
 *
 * v1 is ambiguous by construction: joining `name + "\n" + content` with "\n"
 * means a file whose CONTENT looks like `other.txt\n…` produces the same byte
 * stream as a genuine two-file tree. Anyone able to publish an item could
 * therefore ship different bytes under a digest that still verifies.
 *
 * v2 removes the ambiguity: each file contributes sha256(name ‖ NUL ‖ content)
 * (a NUL cannot appear in a path), and those fixed-width hex digests are
 * joined. No separator inside the hashed input is attacker-influenced.
 */
export function itemDigest(files: Record<string, string>, version: "v1" | "v2" = "v2"): string {
  const names = Object.keys(files).sort();
  if (version === "v1") {
    return sha256Hex(names.map((n) => `${n}\n${files[n]}`).join("\n"));
  }
  return sha256Hex(names.map((n) => sha256Hex(`${n}\u0000${files[n]}`)).join("\n"));
}
