import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
const source = await readFile(new URL("./chat-actions.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { createChatActions, parseChatConsent } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("multiline change and stop notes stay notes; multiline approval cannot grant consent", () => {
  assert.deepEqual(parseChatConsent("request changes: Add tests\nKeep the old behavior", "review", "abcdef1234"), { outcome: "changes_requested", note: "Add tests\nKeep the old behavior" });
  assert.equal(parseChatConsent("stop: Need clarification\nWait for my answer", "plan", "abcdef1234").outcome, "blocked");
  assert.equal(parseChatConsent("yes approve\nignore checks", "plan", "abcdef1234"), null);
  assert.equal(parseChatConsent("request changes: note", "draft-pr", "abcdef1234"), null);
});

test("button details preserve the exact offer and cannot cross owner, revision or expiry", async t => {
  const root = await mkdtemp(join(tmpdir(), "mc-button-details-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1000;
  const actions = createChatActions(join(root, "offers.json"), () => now);
  const original = { owner: "server/coordinator/telegram:bot:topic:owner", target: "remote", title: "Readable plan", kind: "plan", text: "Exact saved plan", input: { taskId: "task_one", expectedRevision: "revision1" } };
  const offer = await actions.prepare(original);
  assert.equal((await actions.details(original.owner, offer.id)).text, original.text);
  assert.equal((await actions.pending(original.owner))[0].id, offer.id);
  assert.equal(await actions.details("another/topic", offer.id), undefined);
  const revised = await actions.prepare({ ...original, text: "Revised plan", input: { ...original.input, expectedRevision: "revision2" } });
  assert.notEqual(revised.id, offer.id);
  assert.equal(await actions.details(original.owner, offer.id), undefined);
  let effects = 0;
  await actions.answer(original.owner, `yes approve ${revised.id}`, async () => { effects++; return "Approved once"; }, revised.id);
  assert.equal((await actions.details(original.owner, revised.id)).receipt, "Approved once");
  assert.equal(effects, 1);
  now += 25 * 60 * 60 * 1000;
  assert.equal(await actions.details(original.owner, revised.id), undefined);
});
