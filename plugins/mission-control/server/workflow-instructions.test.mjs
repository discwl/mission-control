import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { createWorkflowInstructionsStore } from "./workflow-instructions-store.mjs";
import { effectiveWorkflowInstructions, emptyProjectInstructions, workflowInstructionsPrompt } from "../shared/workflow-instructions.mjs";

const identity = { serverId: "srv_test", projectId: null };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mission-workflow-"));
  t.after(async () => { const resolved = await realpath(root); assert.ok(relative(tmpdir(), resolved).startsWith("mission-workflow-")); await rm(resolved, { recursive: true, force: true }); });
  await writeFile(join(root, "host.json"), JSON.stringify({ schemaVersion: 1, hostId: "test", serverId: identity.serverId }));
  return { root, store: createWorkflowInstructionsStore(root) };
}
async function save(store, projectId, values) {
  const input = { ...identity, projectId };
  const current = await store.read(input);
  return store.save({ ...input, expectedRevision: current.revision, values });
}

test("missing notes have empty defaults; saved Markdown survives a new store without touching host.json", async t => {
  const { root, store } = await fixture(t);
  const originalHost = await readFile(join(root, "host.json"), "utf8");
  const empty = await store.read(identity);
  assert.deepEqual(empty.effective, { intake: "", planning: "" });
  assert.equal(workflowInstructionsPrompt(empty), "");
  const values = { intake: "Clarify vague tickets.\n\n## Sources\nUse Confluence.", planning: "Read the schema before planning." };
  await save(store, null, values);
  assert.deepEqual((await createWorkflowInstructionsStore(root).read(identity)).host, values);
  assert.equal(await readFile(join(root, "host.json"), "utf8"), originalHost);
  assert.match(await readFile(join(root, "Workflow", "host.md"), "utf8"), /## Intake guidance/);
});

test("inherit, append and replace work independently per project and stage, including an empty replacement", async t => {
  const { store } = await fixture(t);
  await save(store, null, { intake: "Ask about missing criteria.", planning: "Use read-only database queries." });
  let a = await save(store, "prj_a", { intake: "Use Confluence.", planning: "", intakeMode: "append", planningMode: "replace" });
  assert.deepEqual(a.effective, { intake: "Ask about missing criteria.\n\nUse Confluence.", planning: "" });
  const b = await store.read({ ...identity, projectId: "prj_b" });
  assert.deepEqual(b.effective, { intake: "Ask about missing criteria.", planning: "Use read-only database queries." });
  a = await save(store, "prj_a", { ...a.project, intakeMode: "inherit" });
  assert.equal(a.project.intake, "Use Confluence.");
  assert.equal(a.effective.intake, "Ask about missing criteria.");
  assert.deepEqual(effectiveWorkflowInstructions(b.host, emptyProjectInstructions()), b.effective);
});

test("host or project changes invalidate stale saves and preserve the current note", async t => {
  const { store } = await fixture(t);
  const old = await store.read({ ...identity, projectId: "prj_a" });
  await save(store, null, { intake: "New host guidance", planning: "" });
  await assert.rejects(store.save({ ...identity, projectId: "prj_a", expectedRevision: old.revision, values: emptyProjectInstructions() }), /changed while/);
  const current = await store.read({ ...identity, projectId: "prj_a" });
  const manual = await save(store, "prj_a", { ...emptyProjectInstructions(), intakeMode: "append", intake: "New project guidance" });
  await assert.rejects(store.save({ ...identity, projectId: "prj_a", expectedRevision: current.revision, values: emptyProjectInstructions() }), /changed while/);
  assert.deepEqual((await store.read({ ...identity, projectId: "prj_a" })).project, manual.project);
});

test("simultaneous saves admit one writer and never leave a lock behind", async t => {
  const { store } = await fixture(t);
  const current = await store.read(identity);
  const input = { ...identity, expectedRevision: current.revision, values: { intake: "A", planning: "B" } };
  const results = await Promise.allSettled([store.save(input), store.save(input)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
  await save(store, null, { intake: "C", planning: "D" });
});

test("wrong hosts, wrong host IDs and path traversal are rejected before any save", async t => {
  const { store } = await fixture(t);
  for (const input of [{ ...identity, serverId: "srv_other" }, { ...identity, hostId: "other" }, { ...identity, projectId: "../escape" }, { ...identity, projectId: "CON\\file" }]) {
    await assert.rejects(store.read(input), /another host|Invalid/);
    await assert.rejects(store.save({ ...input, expectedRevision: "fake", values: input.projectId === null ? { intake: "", planning: "" } : emptyProjectInstructions() }), /another host|Invalid/);
  }
});

test("invalid modes, oversized instructions and reserved markers are rejected", async t => {
  const { store } = await fixture(t);
  for (const values of [{ intake: "x".repeat(8001), planning: "" }, { intake: "<!-- mission-control:intake -->", planning: "" }, { intake: null, planning: "" }]) await assert.rejects(save(store, null, values), /characters|reserved/);
  await assert.rejects(save(store, "prj_a", { intake: "", planning: "", intakeMode: "invalid", planningMode: "inherit" }), /choose/);
});

test("malformed, duplicated or misidentified notes fail visibly rather than falling back", async t => {
  const { root, store } = await fixture(t);
  const saved = await save(store, null, { intake: "Original", planning: "" });
  const original = await readFile(saved.paths.host, "utf8");
  for (const note of [original.replace('hostId: "test"', 'hostId: "other"'), original.replace('schemaVersion: 1', 'schemaVersion: 2'), original.replace('schemaVersion: 1', 'schemaVersion: 1\nschemaVersion: 1'), original + "\n<!-- mission-control:intake -->\nDuplicate", "invalid"]) {
    await writeFile(saved.paths.host, note);
    await assert.rejects(store.read(identity), /different host|invalid|missing|duplicated/);
  }
  await writeFile(saved.paths.host, original.replaceAll("\n", "\r\n"));
  assert.equal((await store.read(identity)).host.intake, "Original");
  assert.ok(root);
});

test("linked folders or note files cannot escape the vault", async t => {
  const { root, store } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "mission-workflow-outside-"));
  t.after(async () => { const resolved = await realpath(outside); assert.ok(relative(tmpdir(), resolved).startsWith("mission-workflow-outside-")); await rm(resolved, { recursive: true, force: true }); });
  await symlink(outside, join(root, "Workflow"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(store.read(identity), /cannot be links/);
  await assert.rejects(save(store, null, { intake: "", planning: "" }), /cannot be links/);
});

test("prompts include source identity and preserve clarification, read-only and approval rules", async t => {
  const { store } = await fixture(t);
  const snapshot = await save(store, "prj_a", { intake: "Clarify scope.", planning: "Check the data model.", intakeMode: "append", planningMode: "append" });
  const prompt = workflowInstructionsPrompt(snapshot);
  for (const text of ["Clarify scope.", "Check the data model.", snapshot.paths.project, snapshot.revision, "already supplied", "Needs you", "authorize tracker/database writes", "existing authorizations"]) assert.ok(prompt.includes(text));
  const morning = workflowInstructionsPrompt(snapshot, ["intake"]);
  assert.ok(morning.includes("Clarify scope."));
  assert.ok(!morning.includes("Check the data model."));
});

const require = createRequire(import.meta.url);
const ts = require("typescript");
function loadTs(file, mocks) {
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(id => Object.hasOwn(mocks, id) ? mocks[id] : require(id), module, module.exports);
  return module.exports;
}

test("Start, Resume and /mission-task prompts load current effective guidance for the bound task", async t => {
  const { root, store } = await fixture(t);
  const task = { hostId: "test", projectId: "prj_a", title: "Clarify a ticket" };
  const runs = loadTs("./runs.ts", {
    "./tasks": { localServerId: async () => identity.serverId, assignedTask: async (serverId, workspaceId, taskId) => { assert.equal(serverId, identity.serverId); assert.equal(workspaceId, "wks_a"); assert.equal(taskId, "task_aaaa"); return { task, file: "task.md" }; } },
    "../shared/vault": { defaultVaultPath: root },
    "../shared/runs": { runSchema: {} },
  });
  await save(store, null, { intake: "Ask about unclear scope.", planning: "Read Confluence." });
  let prompt = (await runs.taskAgentPrompt("wks_a", "task_aaaa")).prompt;
  assert.match(prompt, /Ask about unclear scope\./);
  assert.match(prompt, /Read Confluence\./);
  assert.match(prompt, /Read workflowInstructions from dev-flow context on every start and resume/);
  assert.ok(!prompt.includes("It is due"), "no deadline line without a due date");
  task.dueDate = "2026-10-08";
  assert.match((await runs.taskAgentPrompt("wks_a", "task_aaaa")).prompt, /It is due 2026-10-08\. Plan to finish, validate and hand off before then/);
  delete task.dueDate;
  await save(store, "prj_a", { intake: "Project clarification.", planning: "", intakeMode: "replace", planningMode: "replace" });
  prompt = (await runs.taskAgentPrompt("wks_a", "task_aaaa")).prompt;
  assert.match(prompt, /Project clarification\./);
  assert.ok(!prompt.includes("Read Confluence."));
  task.hostId = "other";
  await assert.rejects(runs.taskAgentPrompt("wks_a", "task_aaaa"), /another host/);
});

test("settings RPCs validate the selected host and live project before writing", async t => {
  const { root, store } = await fixture(t);
  const callbacks = new Map();
  const { registerWorkflowInstructions } = loadTs("./workflow-instructions.ts", {
    "../shared/vault": { defaultVaultPath: root },
    "../shared/workflow-settings": { getWorkflowInstructions: "read", saveWorkflowInstructions: "save" },
  });
  registerWorkflowInstructions({ handle: (name, callback) => callbacks.set(name, callback) });
  const context = { paseo: { projects: { list: async () => ({ projects: [{ projectId: "prj_a" }] }) } } };
  const read = callbacks.get("read"), write = callbacks.get("save");
  await assert.rejects(read({ ...identity, projectId: "prj_other" }, context), /unavailable/);
  await assert.rejects(read({ ...identity, serverId: "srv_other" }, context), /another host/);
  const snapshot = await read({ ...identity, projectId: "prj_a" }, context);
  const saved = await write({ ...identity, projectId: "prj_a", expectedRevision: snapshot.revision, values: { ...emptyProjectInstructions(), intake: "Clarify the ticket.", intakeMode: "append" } }, context);
  assert.equal(saved.effective.intake, "Clarify the ticket.");
  await assert.rejects(write({ ...identity, projectId: "prj_other", expectedRevision: snapshot.revision, values: emptyProjectInstructions() }, context), /unavailable/);
  assert.equal((await store.read({ ...identity, projectId: "prj_a" })).project.intake, "Clarify the ticket.");
});
