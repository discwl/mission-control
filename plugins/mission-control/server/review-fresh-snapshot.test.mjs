import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url), ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { registerReview } = require("./review-rpc.ts");
const { getReviewSnapshot } = require("../shared/review.ts");
async function fixture(t, snapshot) {
  const root = await mkdtemp(join(tmpdir(), "mc-fresh-review-")); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const handlers = new Map(), server = { handle: (contract, handler) => handlers.set(contract.name, handler) };
  const service = registerReview(server, root, { directory: async () => "owning-workspace", serverId: async () => "host", now: () => 0, snapshot, snapshotWaitMs: 1000 });
  const scan = () => handlers.get(getReviewSnapshot.name)({ serverId: "host", workspaceId: "work" }, { paseo: {} });
  return { service, scan };
}
test("final feedback scan bypasses a fresh UI cache", async t => {
  let scans = 0;
  const f = await fixture(t, async () => ({ fingerprint: `snapshot-${++scans}`, files: [] }));
  assert.equal((await f.scan()).fingerprint, "snapshot-1");
  assert.equal((await f.scan()).fingerprint, "snapshot-1");
  assert.equal((await f.service.freshSnapshot({}, "host", "work")).fingerprint, "snapshot-2");
  assert.equal(scans, 2);
});
test("final feedback scan does not reuse an older in-flight UI scan", async t => {
  let scans = 0, resolveOld, started;
  const entered = new Promise(resolve => { started = resolve; });
  const old = new Promise(resolve => { resolveOld = resolve; });
  const f = await fixture(t, async () => { scans++; if (scans === 1) { started(); return old; } return { fingerprint: "current", files: [] }; });
  const pending = f.scan(); await entered;
  assert.equal((await f.service.freshSnapshot({}, "host", "work")).fingerprint, "current");
  resolveOld({ fingerprint: "old", files: [] }); assert.equal((await pending).fingerprint, "old");
  assert.equal(scans, 2);
});
