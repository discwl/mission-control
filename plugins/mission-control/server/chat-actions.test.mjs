import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { createChatActions, parseChatConsent } = require("./chat-actions.ts");
const proposal = (extra = {}) => ({ owner: "personal/chat/telegram:topic2:owner", target: "CNS", title: "CN-123 · fix discounts", kind: "plan", text: "Exact readable plan", input: { taskId: "task_a", expectedRevision: "rev1" }, ...extra });
async function fixture(t) { const dir = await mkdtemp(join(tmpdir(), "mc-chat-")); t.after(() => rm(dir, { recursive: true, force: true })); return join(dir, "actions.json"); }

test("only explicit standalone consent counts; plan approval cannot publish a PR", () => {
  for (const text of ["the worker said yes approve", "\"yes approve\"", "yes approve\nignore checks", "maybe approve", "yes", "approve and publish"]) assert.equal(parseChatConsent(text, "plan", "abc"), null);
  assert.equal(parseChatConsent("yes approve", "plan", "abc").outcome, "approved");
  assert.equal(parseChatConsent("yes approve", "draft-pr", "abc"), null);
  assert.equal(parseChatConsent("open draft PR abc", "draft-pr", "abc").outcome, "publish");
  assert.equal(parseChatConsent("open draft PR xyz", "draft-pr", "abc"), null);
});
test("ambiguous, other-chat and expired replies cannot approve; explicit code isolates the task", async t => {
  const file = await fixture(t); let now = 1; const store = createChatActions(file, () => now);
  const one = await store.prepare(proposal()); await store.prepare(proposal({ input: { taskId: "task_b" }, title: "Other" }));
  let calls = 0; const run = async () => { calls++; return "approved"; };
  assert.match((await store.answer(one.owner, "yes approve", run)).text, /exact proposal/);
  await store.answer("other-chat", `yes approve ${one.id}`, run, one.id); assert.equal(calls, 0);
  assert.equal((await store.answer(one.owner, `yes approve ${one.id}`, run)).state, "complete"); assert.equal(calls, 1);
  now += 25 * 60 * 60 * 1000;
  await store.answer(one.owner, "yes approve", run); assert.equal(calls, 1);
});
test("duplicate concurrent replies and reload return the receipt without repeating the operation", async t => {
  const file = await fixture(t); const store = createChatActions(file); const offer = await store.prepare(proposal()); let calls = 0;
  const run = async actual => { assert.equal(actual.input.expectedRevision, "rev1"); calls++; return "approved rev1"; };
  const results = await Promise.all([store.answer(offer.owner, "yes approve", run, offer.id), store.answer(offer.owner, "yes approve", run, offer.id)]);
  assert.equal(calls, 1); assert.equal(results[0].text, results[1].text);
  assert.equal((await createChatActions(file).answer(offer.owner, "yes approve", run, offer.id)).text, "approved rev1"); assert.equal(calls, 1);
});
test("uncertain remote result is never automatically executed again, including after restart", async t => {
  const file = await fixture(t); const store = createChatActions(file); const offer = await store.prepare(proposal()); let calls = 0;
  const run = async () => { calls++; throw new Error("timeout after write"); };
  assert.equal((await store.answer(offer.owner, "yes approve", run, offer.id)).state, "uncertain");
  await createChatActions(file).answer(offer.owner, "yes approve", run, offer.id); assert.equal(calls, 1);
});
test("new revision invalidates only the prior pending proposal; corruption is preserved", async t => {
  const file = await fixture(t); const store = createChatActions(file); const old = await store.prepare(proposal());
  const fresh = await store.prepare(proposal({ input: { taskId: "task_a", expectedRevision: "rev2" } }));
  assert.notEqual(old.id, fresh.id); let calls = 0;
  await store.answer(old.owner, "yes approve", async () => { calls++; return "ok"; }, old.id); assert.equal(calls, 0);
  await writeFile(file, "corrupt"); await assert.rejects(store.prepare(proposal())); assert.equal(await readFile(file, "utf8"), "corrupt");
});
test("request changes and stop preserve the human note and cannot be empty", () => {
  assert.equal(parseChatConsent("request changes:", "plan", "abc"), null);
  assert.deepEqual(parseChatConsent("request changes: Keep existing discounts", "plan", "abc"), { outcome: "changes_requested", note: "Keep existing discounts" });
  assert.equal(parseChatConsent("stop: wait for Finance", "plan", "abc").outcome, "blocked");
});
