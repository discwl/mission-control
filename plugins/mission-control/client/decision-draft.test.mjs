import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(import.meta.url), ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { createPageMemory } = require("./page-memory.ts"), model = require("./decision-card-model.ts");
const entry = () => ({ revision: "request-one", decision: { workspaceId: "workspace-a", taskId: "task-a", runId: "run-a", decisionId: "decision-a" }, findings: [] });
function runtime(storage = new Map(), writable = true) {
  const memory = createPageMemory(), exports = {};
  const source = ts.transpileModule(readFileSync(new URL("./decision-draft.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, require: name => {
    if (name === "zod") return require("zod");
    if (name === "./decision-card-model") return model;
    if (name === "./page-memory") return { pageMemory: memory, pageKey: (...parts) => JSON.stringify(parts) };
    if (name === "./page-state") return { usePageState: (key, initial) => [memory.read(key, initial)] };
    if (name === "./web") return { readClientStorage: key => storage.get(key) ?? null, writeClientStorage: (key, value) => { if (!writable) return false; if (value === null) storage.delete(key); else storage.set(key, value); return true; } };
    throw Error(name);
  } });
  return { ...exports, storage };
}
test("unsent notes and confirmation intent survive navigation and a new client session", () => {
  const r = runtime(), e = entry();
  r.useDecisionDraft(e, "host-a").setNote({ text: "Keep the existing subscriptions unchanged.", edited: true });
  const next = r.useDecisionDraft(e, "host-a");
  assert.equal(next.draft.note.text, "Keep the existing subscriptions unchanged.");
  assert.equal(next.saved, true);
  assert.equal(next.draft.durable, true);
  next.setConfirm({ id: "change", outcome: "changes_requested", note: "Use the saved note.", confirm: true, prompt: "What should change?", sendLabel: "Send changes", noteRequired: true, requestRevision: e.revision });
  const restored = runtime(r.storage).useDecisionDraft(e, "host-a");
  assert.equal(restored.draft.confirm.note, "Use the saved note.");
  assert.equal(restored.draft.confirm.requestRevision, "request-one");
  assert.equal(restored.draft.note.text, next.draft.note.text);
  assert.equal(restored.stale, false);
  assert.equal(r.useDecisionDraft(e, "host-b").saved, false);
  assert.equal(r.useDecisionDraft({ ...e, decision: { ...e.decision, workspaceId: "workspace-b" } }, "host-a").saved, false);
  assert.equal(r.useDecisionDraft({ ...e, decision: { ...e.decision, runId: "run-b" } }, "host-a").saved, false);
});
test("a changed request retains the draft and original version until explicit rebinding", () => {
  const r = runtime(), e = entry();
  r.useDecisionDraft(e, "host-a").setNote({ text: "Add a concrete behavior example.", edited: true });
  e.revision = "request-two";
  let current = r.useDecisionDraft(e, "host-a");
  assert.equal(current.stale, true);
  current.setNote({ text: "Add an example and a success check.", edited: true });
  assert.equal(r.useDecisionDraft(e, "host-a").draft.requestRevision, "request-one");
  current.useForCurrentRequest();
  current = r.useDecisionDraft(e, "host-a");
  assert.equal(current.stale, false);
  assert.equal(current.draft.note.text, "Add an example and a success check.");
  current.clear();
  assert.equal(r.useDecisionDraft(e, "host-a").saved, false);
  assert.equal(r.storage.size, 0);
});
test("storage failure keeps a session draft and malformed or foreign stored records are ignored", () => {
  const r = runtime(new Map(), false), e = entry();
  r.useDecisionDraft(e, "host-a").setNote({ text: "A session draft.", edited: true });
  assert.equal(r.useDecisionDraft(e, "host-a").draft.durable, false);
  assert.equal(r.useDecisionDraft(e, "host-a").draft.note.text, "A session draft.");
  assert.equal(r.restoreDecisionDraft({ version: 1, identity: "other" }, r.decisionDraftKey(e, "host-a")), null);
  const bad = runtime(new Map([[r.decisionDraftKey(e, "host-a"), "not-json"]]));
  assert.equal(bad.useDecisionDraft(e, "host-a").saved, false);
});
