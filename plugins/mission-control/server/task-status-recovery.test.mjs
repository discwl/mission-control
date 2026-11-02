import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url), ts = require("typescript");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ref = { serverId: "srv_test", workspaceId: "wks_test", projectId: "prj_test", taskId: "task_abcdef01" };
const fields = { schemaVersion: 1, taskId: ref.taskId, hostId: "personal", projectId: ref.projectId,
  title: "PN134 fixture", acceptanceCriteria: "Administrative close only.", status: "done", source: "manual",
  assignments: [{ serverId: ref.serverId, workspaceId: ref.workspaceId }], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" };
const markdown = (f = fields) => `---\r\n${Object.entries(f).map(([k,v]) => `${k}: ${JSON.stringify(v)}`).join("\r\n")}\r\n---\r\n\r\n# Evidence\r\nKeep all body bytes, including status: done.\r\n`;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
function modules(overrides = {}) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const source = readFileSync(file, "utf8");
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: file }).outputText;
    const localRequire = name => name === "node:fs/promises" ? { ...fs, ...overrides }
      : name.startsWith(".") ? load(resolve(dirname(file), `${name}.ts`)) : require(name);
    new Function("require", "module", "exports", output)(localRequire, module, module.exports);
    return module.exports;
  }
  return { server: load(join(root, "server/task-status-recovery.ts")), shared: load(join(root, "shared/task-status-recovery.ts")) };
}
async function fixture(t, overrides = {}) {
  const vault = await fs.mkdtemp(join(tmpdir(), "mc-status-recovery-"));
  t.after(async () => { assert.ok(vault.startsWith(`${resolve(tmpdir())}${sep}`)); await fs.rm(vault, { recursive: true, force: true }); });
  const folder = join(vault, "Tasks", ref.taskId), file = join(folder, "task.md");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(join(vault, "host.json"), JSON.stringify({ schemaVersion: 1, hostId: "personal", serverId: ref.serverId }));
  await fs.writeFile(file, markdown());
  const { server, shared } = modules(overrides);
  const store = server.createTaskStatusRecovery(vault);
  const input = async () => ({ ...ref, expectedRevision: (await store.inspect(ref)).revision, targetStatus: "closed",
    actor: "Coordinator on behalf of user", reason: "Correct unsupported status scalar", authorizationEvidence: "User message exact-reference: close this ticket" });
  return { vault, folder, file, store, input, server, shared };
}
test("exact correction preserves backup/body/metadata and exposes valid public readback", async t => {
  const f = await fixture(t), before = await fs.readFile(f.file), input = await f.input();
  const result = await f.store.apply(input), after = await fs.readFile(f.file, "utf8");
  assert.equal(result.applied, true); assert.equal(result.task.status, "closed");
  assert.equal(result.previousRevision, digest(before)); assert.equal(result.revision, digest(Buffer.from(after)));
  assert.equal(after.replace(/^status:.*$/m, 'status: "done"').replace(/^updatedAt:.*$/m, `updatedAt: ${JSON.stringify(fields.updatedAt)}`), before.toString());
  assert.notEqual(result.task.updatedAt, fields.updatedAt);
  const audit = join(f.vault, result.auditPath);
  assert.deepEqual(await fs.readFile(join(audit, "before.md")), before);
  const prepared = JSON.parse(await fs.readFile(join(audit, "prepared.json"), "utf8"));
  assert.equal(prepared.actorAttribution, "caller-declared"); assert.equal(prepared.actor, input.actor);
  assert.equal(prepared.authorizationEvidence, input.authorizationEvidence); assert.equal(prepared.expectedRevision, digest(before));
  assert.equal(JSON.parse(await fs.readFile(join(audit, "applied.json"), "utf8")).revision, result.revision);
  assert.deepEqual(await f.store.inspect(ref), { ...ref, revision: result.revision, title: fields.title, recordedStatus: "closed", recoverable: false });
  await assert.rejects(f.store.apply(input), /changed since inspection/);
  await assert.rejects(f.store.apply({ ...input, expectedRevision: result.revision }), /status is valid/);
  assert.deepEqual(result.warnings, []);
});
for (const [name, mutate] of [
  ["another malformed field", text => text.replace('source: "manual"', 'source: "unknown"')],
  ["unknown top-level key", text => text.replace('source:', 'unexpected: true\r\nsource:')],
  ["unknown nested key", text => text.replace('"workspaceId":"wks_test"', '"workspaceId":"wks_test","unexpected":true')],
  ["duplicate status", text => text.replace('source:', 'status: "ready"\r\nsource:')],
  ["duplicate identity", text => text.replace('source:', 'taskId: "task_abcdef01"\r\nsource:')],
  ["non-string status", text => text.replace('status: "done"', 'status: null')],
  ["missing status", text => text.replace('status: "done"\r\n', '')],
  ["invalid JSON", text => text.replace('status: "done"', 'status: done')],
]) test(`refuses ${name} without changing bytes`, async t => {
  const f = await fixture(t); const raw = mutate(markdown()); await fs.writeFile(f.file, raw);
  await assert.rejects(f.store.inspect(ref));
  await assert.rejects(f.store.apply({ ...ref, expectedRevision: digest(Buffer.from(raw)), targetStatus: "closed", actor: "user", reason: "fix", authorizationEvidence: "message" }));
  assert.equal(await fs.readFile(f.file, "utf8"), raw);
});
for (const key of ["serverId", "workspaceId", "projectId", "taskId"]) test(`refuses wrong ${key}`, async t => {
  const f = await fixture(t), input = await f.input();
  await assert.rejects(f.store.apply({ ...input, [key]: key === "taskId" ? "task_deadbeef" : "wrong" }));
  assert.equal(await fs.readFile(f.file, "utf8"), markdown());
});
test("stale hash and active lock never mutate task or remove another lock", async t => {
  const f = await fixture(t), input = await f.input();
  await assert.rejects(f.store.apply({ ...input, expectedRevision: "0".repeat(64) }), /changed/);
  const lock = join(f.folder, ".mission-control-write.lock"); await fs.writeFile(lock, "another-owner");
  await assert.rejects(f.store.apply(input), /being updated/);
  assert.equal(await fs.readFile(lock, "utf8"), "another-owner");
  assert.equal(await fs.readFile(f.file, "utf8"), markdown());
});
test("concurrent recovery admits one writer only", async t => {
  const f = await fixture(t), input = await f.input();
  const results = await Promise.allSettled([f.store.apply(input), f.store.apply(input)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
});
test("legacy duplicate, symlink and hardlink refuse recovery", async t => {
  const f = await fixture(t); await fs.writeFile(join(f.vault, "Tasks", `${ref.taskId}.md`), markdown());
  await assert.rejects(f.store.inspect(ref), /duplicate/);
  await fs.unlink(join(f.vault, "Tasks", `${ref.taskId}.md`));
  const original = join(f.folder, "original.md"); await fs.rename(f.file, original); await fs.link(original, f.file);
  await assert.rejects(f.store.inspect(ref), /unlinked/); await fs.unlink(f.file);
  await fs.symlink(original, f.file);
  await assert.rejects(f.store.inspect(ref), /unlinked/);
});
test("mutation during preparation is detected and original evidence remains", async t => {
  let target;
  const f = await fixture(t, { open: async (path, flags) => {
    const h = await fs.open(path, flags);
    if (String(path).endsWith(".tmp")) {
      const sync = h.sync.bind(h); h.sync = async () => { await sync(); await fs.writeFile(target, markdown().replace('"done"', '"other-invalid"')); };
    }
    return h;
  }}); target = f.file;
  await assert.rejects(f.store.apply(await f.input()), /changed during recovery/);
  assert.match(await fs.readFile(f.file, "utf8"), /other-invalid/);
  const audit = (await fs.readdir(f.folder)).find(n => n.startsWith(".mission-control-recovery-"));
  assert.equal(await fs.readFile(join(f.folder, audit, "before.md"), "utf8"), markdown());
  await assert.rejects(fs.stat(join(f.folder, audit, "applied.json")), { code: "ENOENT" });
});
test("replaced lock is neither used nor removed", async t => {
  let lockPath;
  const f = await fixture(t, { open: async (path, flags) => {
    const h = await fs.open(path, flags);
    if (String(path).endsWith(".tmp")) {
      const sync = h.sync.bind(h); h.sync = async () => { await sync(); await fs.unlink(lockPath); await fs.writeFile(lockPath, "new-owner"); };
    }
    return h;
  }}); lockPath = join(f.folder, ".mission-control-write.lock");
  await assert.rejects(f.store.apply(await f.input()), /lock ownership changed/);
  assert.equal(await fs.readFile(lockPath, "utf8"), "new-owner");
  assert.equal(await fs.readFile(f.file, "utf8"), markdown());
});
test("failed initial lock stat still closes its handle", async t => {
  let closed = false;
  const f = await fixture(t, {
    lstat: async (path, options) => { if (String(path).endsWith(".mission-control-write.lock")) throw Object.assign(new Error("stat failed"), { code: "EIO" }); return fs.lstat(path, options); },
    open: async (path, flags) => { const h = await fs.open(path, flags); if (String(path).endsWith(".mission-control-write.lock")) { const close = h.close.bind(h); h.close = async () => { closed = true; return close(); }; } return h; },
  });
  await assert.rejects(f.store.apply(await f.input()), /stat failed/);
  assert.equal(closed, true); assert.equal(await fs.readFile(f.file, "utf8"), markdown());
});

test("rename failure leaves original record and prepared backup, never claims applied", async t => {
  const f = await fixture(t, { rename: async () => { throw Object.assign(new Error("injected rename failure"), { code: "EIO" }); } });
  await assert.rejects(f.store.apply(await f.input()), /injected rename/);
  assert.equal(await fs.readFile(f.file, "utf8"), markdown());
  const audit = (await fs.readdir(f.folder)).find(n => n.startsWith(".mission-control-recovery-"));
  assert.equal(await fs.readFile(join(f.folder, audit, "before.md"), "utf8"), markdown());
});
test("cleanup EBUSY after successful write reports applied plus warning", async t => {
  const f = await fixture(t, { unlink: async path => {
    if (String(path).endsWith(".mission-control-write.lock")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
    return fs.unlink(path);
  }});
  const result = await f.store.apply(await f.input());
  assert.equal(result.applied, true); assert.match(result.warnings.join(" "), /lock cleanup/);
  assert.equal((await f.store.inspect(ref)).recordedStatus, "closed");
});
test("captured public record passes strict eligibility and correction only in a scratch vault", { skip: !process.env.MC_RECOVERY_EVIDENCE_FILE }, async t => {
  const f = await fixture(t), bytes = await fs.readFile(process.env.MC_RECOVERY_EVIDENCE_FILE);
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(bytes.toString())[1];
  const data = Object.fromEntries(head.split(/\r?\n/).map(line => { const at = line.indexOf(":"); return [line.slice(0, at), JSON.parse(line.slice(at + 1))]; }));
  const identity = { serverId: data.assignments[0].serverId, workspaceId: data.worktree?.workspaceId ?? data.assignments[0].workspaceId, projectId: data.projectId, taskId: data.taskId };
  await fs.writeFile(join(f.vault, "host.json"), JSON.stringify({ schemaVersion: 1, hostId: data.hostId, serverId: identity.serverId }));
  const folder = join(f.vault, "Tasks", data.taskId); await fs.mkdir(folder);
  const file = join(folder, "task.md"); await fs.writeFile(file, bytes);
  const inspected = await f.store.inspect(identity);
  assert.equal(inspected.revision, digest(bytes)); assert.equal(inspected.recoverable, true);
  const result = await f.store.apply({ ...identity, expectedRevision: inspected.revision, targetStatus: "closed", actor: "Local fixture only", reason: "Validate captured record in scratch vault", authorizationEvidence: "TEST ONLY; no remote authorization inferred" });
  assert.equal(result.task.status, "closed");
  const changed = await fs.readFile(file, "utf8");
  assert.equal(changed.replace(/^status:.*$/m, `status: ${JSON.stringify(data.status)}`).replace(/^updatedAt:.*$/m, `updatedAt: ${JSON.stringify(data.updatedAt)}`), bytes.toString());
  assert.deepEqual(await fs.readFile(process.env.MC_RECOVERY_EVIDENCE_FILE), bytes);
});

test("public contracts reject missing audit, bad hashes, unsupported targets and arbitrary paths", async t => {
  const f = await fixture(t), input = await f.input();
  for (const bad of [{ ...input, actor: "" }, { ...input, authorizationEvidence: "" }, { ...input, targetStatus: "done" }, { ...input, expectedRevision: "bad" }, { ...input, root: f.vault }]) assert.equal(f.shared.statusRecoveryInput.safeParse(bad).success, false);
  const handlers = new Map(); f.server.registerTaskStatusRecovery({ handle: (contract, fn) => handlers.set(contract.name, fn) });
  assert.deepEqual([...handlers.keys()], ["tasks.status-recovery.inspect", "tasks.status-recovery.apply"]);
  await assert.rejects(handlers.get("tasks.status-recovery.apply")(input, { paseo: { workspaces: { ref: () => ({ refresh: async () => ({ projectId: "wrong" }) }) } } }), /Workspace\/project/);
});
