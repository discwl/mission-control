import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { registerReview } = require("./review-rpc.ts");
const { isReviewScanPending } = require("../shared/review.ts");

const flush = () => new Promise(resolve => setImmediate(resolve));
const snapshotOf = files => ({
  fingerprint: "f", generatedAt: "", repoRoot: "/repo", branch: "main", head: null, base: "head",
  fromCommit: null, sinceCommit: null, baseWarning: null, files, omittedFiles: 0,
});
const file = id => ({ reviewIds: [id] });

// Scans stay open until a test settles them, standing in for Git that takes longer than a request.
async function harness(t, waits = {}) {
  const vault = await mkdtemp(join(tmpdir(), "mission-review-rpc-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  const handlers = new Map();
  const scans = [];
  let now = 1_000_000;
  registerReview({ handle: (rpc, handler) => handlers.set(rpc.name, handler) }, vault, {
    serverId: async () => "srv_local",
    // Workspaces named *shared* are local workspaces on one checkout.
    directory: async (_paseo, _serverId, workspaceId) => workspaceId.includes("shared") ? "/repo" : `/${workspaceId}`,
    now: () => now,
    snapshot: directory => new Promise((resolve, reject) => { scans.push({ directory, resolve, reject }); }),
    snapshotWaitMs: 20,
    countsWaitMs: 20,
    ...waits,
  });
  return {
    scans,
    call: (name, input) => handlers.get(name)(input, { paseo: {} }),
    advance(ms) { now += ms; },
  };
}

test("workspaces on one checkout share a scan, and a slow first scan is pending until it finishes", async t => {
  const h = await harness(t);
  const ids = ["wks_shared_a", "wks_shared_b", "wks_other"];
  const first = await h.call("review.counts", { workspaceIds: ids });
  // The two scans start in whichever order their marks are read from disk.
  assert.deepEqual(h.scans.map(scan => scan.directory).sort(), ["/repo", "/wks_other"]);
  assert.deepEqual(first.pending.sort(), [...ids].sort());
  assert.deepEqual(first.counts, {});

  h.scans.find(scan => scan.directory === "/repo").resolve(snapshotOf([file("aaaaaaaaaaaaaaaa"), file("bbbbbbbbbbbbbbbb")]));
  await flush();
  const second = await h.call("review.counts", { workspaceIds: ids });
  assert.deepEqual(second.counts, { wks_shared_a: { files: 2, toReview: 2 }, wks_shared_b: { files: 2, toReview: 2 } });
  assert.deepEqual(second.pending, ["wks_other"]);
  assert.equal(h.scans.length, 2, "the still-running scan is joined, not restarted");
});

test("a snapshot slower than one request keeps running and answers the next poll", async t => {
  const h = await harness(t);
  const input = { serverId: "srv_local", workspaceId: "wks_shared_a" };
  await assert.rejects(h.call("review.snapshot", input), error => isReviewScanPending(error));
  await assert.rejects(h.call("review.snapshot", input), error => isReviewScanPending(error));
  assert.equal(h.scans.length, 1, "the second request joined the running scan");

  const snapshot = snapshotOf([]);
  h.scans[0].resolve(snapshot);
  await flush();
  h.advance(9_000);
  assert.equal(await h.call("review.snapshot", input), snapshot, "a scan finished since the last poll answers the next one");
  assert.equal(h.scans.length, 1);

  h.advance(10_000);
  await assert.rejects(h.call("review.snapshot", input), error => isReviewScanPending(error));
  assert.equal(h.scans.length, 2, "an older result starts a fresh scan");
});

test("counts keep the last result while a refresh runs, and a failed refresh isn't cached", async t => {
  const h = await harness(t, { countsWaitMs: 5_000 });
  const ids = ["wks_shared_a"];
  const first = h.call("review.counts", { workspaceIds: ids });
  while (!h.scans.length) await flush();
  h.scans[0].resolve(snapshotOf([file("aaaaaaaaaaaaaaaa")]));
  assert.deepEqual((await first).counts, { wks_shared_a: { files: 1, toReview: 1 } });

  h.advance(30_000);
  const during = await h.call("review.counts", { workspaceIds: ids });
  assert.deepEqual(during.counts, { wks_shared_a: { files: 1, toReview: 1 } }, "the older count shows at once");
  assert.deepEqual(during.pending, []);
  assert.equal(h.scans.length, 2, "and a refresh starts behind it");

  h.scans[1].reject(new Error("git failed"));
  await flush();
  const after = await h.call("review.counts", { workspaceIds: ids });
  assert.deepEqual(after.counts, { wks_shared_a: { files: 1, toReview: 1 } });
  assert.equal(h.scans.length, 3, "a failed refresh is retried on the next poll");
});
