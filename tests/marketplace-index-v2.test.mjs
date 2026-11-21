// Marketplace index v2: the digest must be unambiguous, and the three new
// gates (schemaVersion, expiresAt, revoked) must actually refuse things.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

const m = await import("../dist/esm/lib/marketplace/index.js");

const sha = (s) => createHash("sha256").update(s).digest("hex");

test("v1 digests collide where v2 digests do not", () => {
  // Two DIFFERENT file trees that v1 hashes to the same value: in v1 the join is
  // `name \n content`, so a file whose content starts with `b.txt\n…` fabricates
  // the same byte stream as a second file.
  const one = { "a.txt": "hello\nb.txt\nworld" };
  const two = { "a.txt": "hello", "b.txt": "world" };

  assert.equal(m.itemDigest(one, "v1"), m.itemDigest(two, "v1"), "v1 is ambiguous by construction");
  assert.notEqual(m.itemDigest(one, "v2"), m.itemDigest(two, "v2"), "v2 separates the two trees");
});

test("v2 digest is stable and order-independent", () => {
  const a = { "x.md": "1", "y.md": "2" };
  const b = { "y.md": "2", "x.md": "1" };
  assert.equal(m.itemDigest(a, "v2"), m.itemDigest(b, "v2"));
  assert.notEqual(m.itemDigest(a, "v2"), m.itemDigest({ "x.md": "1" }, "v2"));
});

test("verifyItemFiles follows the item's declared digest version", () => {
  const files = { "SKILL.md": "---\nname: x\n---\nbody" };
  const v2 = m.itemDigest(files, "v2");
  assert.equal(m.verifyItemFiles({ id: "x", kind: "skill", version: "1.0.0", path: "skills/x", sha256: v2, digest: "v2" }, files), true);
  // An item with no digest field is a v1 item and must verify with v1 rules.
  const v1 = m.itemDigest(files, "v1");
  assert.equal(m.verifyItemFiles({ id: "x", kind: "skill", version: "1.0.0", path: "skills/x", sha256: v1 }, files), true);
  // …and must NOT verify against the other construction.
  assert.equal(m.verifyItemFiles({ id: "x", kind: "skill", version: "1.0.0", path: "skills/x", sha256: v2 }, files), false);
});

function signed(index, privateKey, keyId) {
  // keyId is part of the signed payload — sign AFTER adding it, exactly as
  // build-index.mjs does.
  const withKey = { ...index, keyId };
  return { ...withKey, signature: sign(null, Buffer.from(m.canonicalJson(withKey), "utf8"), privateKey).toString("base64url") };
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64url");

const baseIndex = (extra = {}) => ({
  schemaVersion: 2,
  seq: 10,
  generatedAt: "2026-01-01T00:00:00.000Z",
  items: [
    { id: "good", kind: "skill", version: "1.0.0", path: "skills/good", sha256: sha("good"), digest: "v2" },
    { id: "pulled", kind: "mcp", version: "1.0.0", path: "mcp/pulled", sha256: sha("pulled"), digest: "v2" },
  ],
  ...extra,
});

test("a schemaVersion this SDK does not understand is refused", () => {
  const future = signed(baseIndex({ schemaVersion: 99 }), privateKey, "k1");
  assert.deepEqual(m.checkIndex(future, { publicKey: pub }), { ok: false, reason: "schema" });
});

test("an expired index is refused even when the signature is valid", () => {
  const expired = signed(baseIndex({ expiresAt: "2020-01-01T00:00:00.000Z" }), privateKey, "k1");
  assert.deepEqual(m.checkIndex(expired, { publicKey: pub }), { ok: false, reason: "expired" });
  const live = signed(baseIndex({ expiresAt: "2999-01-01T00:00:00.000Z" }), privateKey, "k1");
  assert.equal(m.checkIndex(live, { publicKey: pub }).ok, true);
});

test("a tampered index fails the signature gate", () => {
  const good = signed(baseIndex(), privateKey, "k1");
  const tampered = { ...good, seq: 11 };
  assert.deepEqual(m.checkIndex(tampered, { publicKey: pub }), { ok: false, reason: "signature" });
});

test("revoked ids are filtered out of the resolved catalog", () => {
  const index = signed(baseIndex({ revoked: ["pulled"] }), privateKey, "k1");
  const items = m.resolveCatalog(index, { appVersion: "3.0.0" });
  assert.deepEqual(items.map((i) => i.id), ["good"]);
});

test("a rotated key in the index verifies when the pinned key does not", () => {
  const rotated = generateKeyPairSync("ed25519");
  const rotatedPub = rotated.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const index = signed(baseIndex({ keys: [{ keyId: "k2", publicKey: rotatedPub }] }), rotated.privateKey, "k2");
  assert.equal(m.checkIndex(index, { publicKey: pub }).ok, true, "keyring key accepted");
  assert.equal(m.checkIndex(index, { publicKey: null }).ok, false, "no host key at all is refused");
});
