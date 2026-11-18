// Contract tests for @orplex/sdk — run against the built ESM output so a green
// run proves the published artifact works, not just the TypeScript sources.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createFileCache, loadCatalog, canonicalJson, verifyIndex, satisfiesRange, sha256Hex, verifyItemFiles, resolveCatalog } from "../dist/esm/marketplace.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyB64Url = publicKey.export({ format: "der", type: "spki" }).toString("base64url");

function signIndex(payload) {
  const signature = sign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey).toString("base64url");
  return { ...payload, signature };
}

const baseIndex = {
  schemaVersion: 1,
  generatedAt: "2025-01-01T00:00:00.000Z",
  minAppVersion: null,
  items: [
    { id: "github", kind: "mcp", version: "1.0.0", engine: ">=2.0.0 <3", path: "mcp/github", sha256: "a".repeat(64) },
    { id: "legacy", kind: "mcp", version: "0.9.0", engine: ">=1.0.0 <2", path: "mcp/legacy", sha256: "b".repeat(64) },
    { id: "review", kind: "skill", version: "1.0.0", path: "skills/review", sha256: "c".repeat(64) },
  ],
};

test("canonicalJson is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
});

test("verifyIndex accepts a genuine signature", () => {
  const index = signIndex(baseIndex);
  assert.equal(verifyIndex(index, publicKeyB64Url), true);
});

test("verifyIndex rejects tampering, a missing signature and a foreign key", () => {
  const index = signIndex(baseIndex);
  const tampered = { ...index, items: [{ ...index.items[0], path: "mcp/evil" }, ...index.items.slice(1)] };
  assert.equal(verifyIndex(tampered, publicKeyB64Url), false);
  assert.equal(verifyIndex({ ...index, signature: null }, publicKeyB64Url), false);

  const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  assert.equal(verifyIndex(index, other), false);
  assert.equal(verifyIndex(index, "not-a-key"), false);
});

test("verifyIndex rejects an index whose signature was stripped", () => {
  const { signature, ...unsigned } = signIndex(baseIndex);
  assert.equal(verifyIndex(unsigned, publicKeyB64Url), false);
});

test("satisfiesRange handles the ranges the catalog actually uses", () => {
  assert.equal(satisfiesRange("2.5.0", ">=2.0.0 <3"), true);
  assert.equal(satisfiesRange("3.0.0", ">=2.0.0 <3"), false);
  assert.equal(satisfiesRange("2.9.9", "^2.1.0"), true);
  assert.equal(satisfiesRange("3.0.0", "^2.1.0"), false);
  assert.equal(satisfiesRange("2.1.5", "~2.1.0"), true);
  assert.equal(satisfiesRange("2.2.0", "~2.1.0"), false);
  assert.equal(satisfiesRange("9.9.9", null), true);
  assert.equal(satisfiesRange("9.9.9", "*"), true);
  assert.equal(satisfiesRange("2.4.0", "2.x"), true);
});

test("resolveCatalog drops items this app version cannot run", () => {
  const index = signIndex(baseIndex);
  assert.deepEqual(resolveCatalog(index, { appVersion: "2.4.0" }).map((i) => i.id), ["github", "review"]);
  assert.deepEqual(resolveCatalog(index, { appVersion: "1.5.0" }).map((i) => i.id), ["legacy", "review"]);
  assert.deepEqual(resolveCatalog(index, { appVersion: "2.4.0", kinds: ["skill"] }).map((i) => i.id), ["review"]);
});

test("loadCatalog falls back to the seed when the network is down and nothing is verified", async () => {
  const failing = async () => {
    throw new Error("offline");
  };
  const seed = { ...baseIndex, signature: null };
  const result = await loadCatalog({
    appVersion: "2.4.0",
    publicKey: publicKeyB64Url,
    fetchImpl: failing,
    seed,
  });
  assert.equal(result.source, "seed");
  assert.equal(result.verified, false);
  assert.equal(result.items.length, 2); // legacy is engine-filtered out
  assert.deepEqual(result.items.map((i) => i.id), ["github", "review"]);
});

test("loadCatalog ignores an unsigned index served over the network", async () => {
  const serveUnsigned = async () => new Response(JSON.stringify(baseIndex), { status: 200 });
  const result = await loadCatalog({
    appVersion: "2.4.0",
    publicKey: publicKeyB64Url,
    fetchImpl: serveUnsigned,
  });
  assert.equal(result.verified, false);
  assert.equal(result.items.length, 0);
  assert.match(result.error ?? "", /signature/);
});

test("loadCatalog accepts a signed index and caches it", async () => {
  const signed = signIndex(baseIndex);
  const cache = createFileCache("D:/orplex-sdk/.tmp-test-cache");
  const serve = async () => new Response(JSON.stringify(signed), { status: 200, headers: { etag: 'W/"1"' } });
  const first = await loadCatalog({ appVersion: "2.4.0", publicKey: publicKeyB64Url, fetchImpl: serve, cache });
  assert.equal(first.source, "network");
  assert.equal(first.verified, true);
  assert.deepEqual(first.items.map((i) => i.id), ["github", "review"]);

  const second = await loadCatalog({
    appVersion: "2.4.0",
    publicKey: publicKeyB64Url,
    fetchImpl: async () => {
      throw new Error("should not be called while the cache is fresh");
    },
    cache,
  });
  assert.equal(second.source, "cache");
});

test("verifyItemFiles compares the catalog digest", () => {
  const files = { "SKILL.md": "# review\n" };
  const digest = sha256Hex(Object.keys(files).sort().map((n) => `${n}\n${files[n]}`).join("\n"));
  assert.equal(verifyItemFiles({ id: "review", kind: "skill", version: "1.0.0", path: "skills/review", sha256: digest }, files), true);
  assert.equal(verifyItemFiles({ id: "review", kind: "skill", version: "1.0.0", path: "skills/review", sha256: digest }, { "SKILL.md": "# tampered\n" }), false);
  assert.equal(verifyItemFiles({ id: "review", kind: "skill", version: "1.0.0", path: "skills/review", sha256: digest }, {}), false);
});