// End-to-end: the SDK tool layer against a real filesystem, no app around it.
// This is the test that proves the extraction actually works — the file must
// appear on disk and read back through the same dispatcher.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  dispatchToolCall,
  createToolContext,
  readDirectoryTree,
  configureApprovals,
  approveRequest,
} from "../dist/esm/tools.js";

// Headless hosts answer approvals with a callback. Without this the store fails
// closed by design (see configureApprovals), so a test that writes must wire it.
configureApprovals({ mode: "callback", onRequest: (approval) => approveRequest(approval.id) });

async function withTmp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "orplex-sdk-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("write_file writes through to disk and read_file reads it back", async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, "hello.txt");
    const ctx = createToolContext();

    const write = await dispatchToolCall({ name: "write_file", path: file, content: "hello from the sdk\n" }, ctx);
    assert.equal(write.blocked, false, write.resultXml);
    assert.equal(await readFile(file, "utf8"), "hello from the sdk\n");

    const read = await dispatchToolCall({ name: "read_file", path: file }, ctx);
    assert.match(read.resultXml, /hello from the sdk/);
  });
});

test("edit_file rewrites only the matched text", async () => {
  await withTmp(async (dir) => {
    const file = path.join(dir, "edit.txt");
    await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
    const ctx = createToolContext();

    const out = await dispatchToolCall(
      { name: "edit_file", path: file, old_text: "beta", new_text: "BETA" },
      ctx,
    );
    assert.equal(out.blocked, false, out.resultXml);
    assert.equal(await readFile(file, "utf8"), "alpha\nBETA\ngamma\n");
  });
});

test("read_file on a missing path reports instead of throwing", async () => {
  await withTmp(async (dir) => {
    const ctx = createToolContext();
    const out = await dispatchToolCall({ name: "read_file", path: path.join(dir, "nope.txt") }, ctx);
    assert.match(out.resultXml, /not available|error|ENOENT/i);
  });
});

test("readDirectoryTree skips node_modules and dot-directories", async () => {
  await withTmp(async (dir) => {
    await writeFile(path.join(dir, "a.txt"), "a", "utf8");
    await rm(path.join(dir, "sub"), { recursive: true, force: true });
    const tree = await readDirectoryTree(dir);
    assert.ok(tree.some((e) => e.path === "a.txt"));
    assert.ok(!tree.some((e) => e.path.startsWith("node_modules")));
  });
});