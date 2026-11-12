import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile, unlink, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
async function fault(name, replacement, action) {
  const original = fs[name]; fs[name] = replacement(original); syncBuiltinESMExports();
  try { return await action(); } finally { fs[name] = original; syncBuiltinESMExports(); }
}
import { clearLegacyRunLock, inspectRunLock, LEGACY_LOCK_MIN_AGE_MS, recoverRunLock, runningAgentsInWorkspace, withRunLock } from "./run-lock.mjs";
const moduleUrl = new URL("./run-lock.mjs", import.meta.url).href;
async function fixture(t) { const folder = await mkdtemp(join(tmpdir(), "mc-run-lock-")); t.after(() => rm(folder, { recursive: true, force: true })); return folder; }
const recovery = view => ({ expectedRevision: view.revision, expectedFileIdentity: view.fileIdentity, expectedNonce: view.owner.nonce, actor: "test-author", reason: "Explicit fixture recovery after owner exit" });
function child(folder, body) {
  const code = `import {withRunLock} from ${JSON.stringify(moduleUrl)}; import{appendFile,writeFile}from'node:fs/promises'; const folder=process.argv[1]; ${body}`;
  const proc = spawn(process.execPath, ["--input-type=module", "-e", code, folder], { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  let stderr = ""; proc.stderr.on("data", bytes => { stderr += bytes; });
  return { proc, exit: once(proc, "exit"), errors: () => stderr };
}
async function crashed(t, folder, body = "process.send('held'); await new Promise(()=>{setInterval(()=>{},1000);});") {
  const c = child(folder, `await withRunLock(folder,async()=>{${body}});`);
  const timer = setTimeout(() => c.proc.kill(), 10000);
  t.after(() => { clearTimeout(timer); c.proc.kill(); });
  await once(c.proc, "message"); clearTimeout(timer);
  const view = await inspectRunLock(folder); assert.equal(view.state, "owned-unverified");
  c.proc.kill(); await c.exit; return view;
}
test("malformed gate reports storage failure rather than a busy writer", async t => {
  const folder = await fixture(t); const bytes = "not a SQLite database";
  await writeFile(join(folder, ".write-gate.sqlite"), bytes);
  await assert.rejects(withRunLock(folder, async () => assert.fail("no callback")), error => error.code === "RUN_LOCK_GATE_FAILURE" && error.cause.errcode === 26);
  assert.equal(await readFile(join(folder, ".write-gate.sqlite"), "utf8"), bytes);
  assert.equal((await inspectRunLock(folder)).state, "absent");
});
test("non-contention failures at either acquisition are not retried or called busy", async t => {
  const { DatabaseSync } = await import("node:sqlite"); const original = DatabaseSync.prototype.exec;
  for (const failedAttempt of [1, 2]) {
    const folder = await fixture(t); let begins = 0;
    const cause = Object.assign(new Error("fixture storage failure"), { errcode: failedAttempt === 1 ? 8 : 10 });
    DatabaseSync.prototype.exec = function(sql) { if (sql === "BEGIN IMMEDIATE" && ++begins === failedAttempt) throw cause; return original.call(this, sql); };
    try { await assert.rejects(withRunLock(folder, async () => assert.fail("no callback")), error => error.code === "RUN_LOCK_GATE_FAILURE" && error.cause === cause); }
    finally { DatabaseSync.prototype.exec = original; }
    assert.equal(begins, failedAttempt); assert.equal((await inspectRunLock(folder)).state, "absent");
  }
});
test("transient unlink errors retry ownership checks without repeating action", async t => {
  const folder = await fixture(t); let attempts = 0, calls = 0;
  await fault("unlink", original => async path => {
    if (path.endsWith(".write.lock") && ++attempts < 3) throw Object.assign(new Error("sharing violation"), { code: "EBUSY" });
    return original(path);
  }, async () => assert.equal(await withRunLock(folder, async () => { calls++; return 7; }), 7));
  assert.equal(attempts, 3); assert.equal(calls, 1); assert.equal((await inspectRunLock(folder)).state, "absent");
});
test("permanent cleanup error exposes applied result and retains recoverable lock", async t => {
  const folder = await fixture(t); let attempts = 0, calls = 0;
  await fault("unlink", original => async path => {
    if (path.endsWith(".write.lock")) { attempts++; throw Object.assign(new Error("locked"), { code: "EBUSY" }); }
    return original(path);
  }, async () => assert.rejects(withRunLock(folder, async () => { calls++; return "saved"; }), error => error.code === "RUN_LOCK_CLEANUP" && error.actionSucceeded && error.result === "saved"));
  assert.equal(attempts, 6); assert.equal(calls, 1);
  await recoverRunLock(folder, recovery(await inspectRunLock(folder))); assert.equal(calls, 1);
});
test("replacement during cleanup retry is preserved", async t => {
  const folder = await fixture(t); let attempts = 0;
  await fault("unlink", original => async path => {
    if (path.endsWith(".write.lock") && ++attempts === 1) { await original(path); await writeFile(path, "new owner"); throw Object.assign(new Error("busy"), { code: "EBUSY" }); }
    return original(path);
  }, async () => assert.rejects(withRunLock(folder, async () => "applied"), error => error.code === "RUN_LOCK_CLEANUP" && error.cleanupError.code === "RUN_LOCK_CHANGED"));
  assert.equal(attempts, 1); assert.equal(await readFile(join(folder, ".write.lock"), "utf8"), "new owner");
});
test("partial owner initialization refuses callback and leaves unknown lock", async t => {
  const folder = await fixture(t); const expected = new Error("metadata disk failure"); let calls = 0;
  await fault("open", original => async (...args) => {
    const handle = await original(...args);
    if (args[0].endsWith(".write.lock") && args[1] === "wx") handle.writeFile = async () => { throw expected; };
    return handle;
  }, async () => assert.rejects(withRunLock(folder, async () => { calls++; }), error => error === expected));
  assert.equal(calls, 0); assert.equal((await inspectRunLock(folder)).state, "legacy");
  await assert.rejects(withRunLock(folder, async () => assert.fail("unknown owner")), { code: "RUN_LOCK_OCCUPIED" });
});
test("completion audit failure reports removal instead of implying rollback", async t => {
  const folder = await fixture(t); const view = await crashed(t, folder);
  await fault("open", original => async (...args) => {
    if (args[0].endsWith(".completed.json")) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return original(...args);
  }, async () => assert.rejects(recoverRunLock(folder, recovery(view)), error => error.code === "RUN_LOCK_RECOVERY_AUDIT" && error.applied === true && !!error.audit));
  assert.equal((await inspectRunLock(folder)).state, "absent");
  assert.equal((await readdir(folder)).filter(name => name.startsWith(".write-recovery-")).length, 1);
});
test("crash after prepared audit retains original lock and evidence", async t => {
  const folder = await fixture(t); const view = await crashed(t, folder);
  const c = child(folder, `const fs=(await import('node:fs/promises')).default; const {syncBuiltinESMExports}=await import('node:module'); const {recoverRunLock}=await import(${JSON.stringify(moduleUrl)}); fs.unlink=async()=>{process.send('audit-prepared');await new Promise(()=>{setInterval(()=>{},1000);});};syncBuiltinESMExports();await recoverRunLock(folder,${JSON.stringify(recovery(view))});`);
  t.after(() => c.proc.kill()); await once(c.proc, "message"); c.proc.kill(); await c.exit;
  assert.equal((await inspectRunLock(folder)).revision, view.revision);
  const audits = (await readdir(folder)).filter(name => name.startsWith(".write-recovery-")).length; assert.equal(audits, 1);
  await recoverRunLock(folder, recovery(view)); assert.equal((await inspectRunLock(folder)).state, "absent");
});
test("crash after removal leaves prepared audit and does not repeat recovery", async t => {
  const folder = await fixture(t); const view = await crashed(t, folder);
  const c = child(folder, `const fs=(await import('node:fs/promises')).default;const {syncBuiltinESMExports}=await import('node:module');const {recoverRunLock}=await import(${JSON.stringify(moduleUrl)});const original=fs.open;fs.open=async(...args)=>{if(args[0].endsWith('.completed.json')){process.send('removed');await new Promise(()=>{setInterval(()=>{},1000);});}return original(...args);};syncBuiltinESMExports();await recoverRunLock(folder,${JSON.stringify(recovery(view))});`);
  t.after(() => c.proc.kill()); await once(c.proc, "message"); c.proc.kill(); await c.exit;
  assert.equal((await inspectRunLock(folder)).state, "absent");
  assert.equal((await readdir(folder)).filter(name => name.startsWith(".write-recovery-")).length, 1);
  await assert.rejects(recoverRunLock(folder, recovery(view)), { code: "RUN_LOCK_LEGACY" });
});
test("two recovery requests cannot both reclaim the same owner", async t => {
  const folder = await fixture(t); const view = await crashed(t, folder);
  const results = await Promise.allSettled([recoverRunLock(folder, recovery(view)), recoverRunLock(folder, recovery(view))]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.code, "RUN_LOCK_LEGACY");
});
test("owner metadata precedes action; normal release and original errors survive", async t => {
  const folder = await fixture(t);
  assert.equal(await withRunLock(folder, async () => { const view = await inspectRunLock(folder); assert.equal(view.state, "owned-unverified"); assert.equal(view.owner.pid, process.pid); return 42; }), 42);
  assert.equal((await inspectRunLock(folder)).state, "absent");
  const expected = new Error("callback failed");
  await assert.rejects(withRunLock(folder, async () => { throw expected; }), error => error === expected);
  let caught = false; try { await withRunLock(folder, async () => { throw undefined; }); } catch (error) { caught = true; assert.equal(error, undefined); }
  assert.equal(caught, true); assert.equal((await inspectRunLock(folder)).state, "absent");
});
test("legacy empty and malformed locks never execute, expire or auto-recover", async t => {
  const folder = await fixture(t); let calls = 0;
  for (const contents of ["", "not-json", '{"pid":99999999}', '{"protocol":"mc-run-lock-v1"}']) {
    await writeFile(join(folder, ".write.lock"), contents);
    await assert.rejects(withRunLock(folder, async () => { calls++; }), { code: "RUN_LOCK_OCCUPIED" });
    const view = await inspectRunLock(folder); assert.equal(view.state, contents === "" ? "legacy" : "unknown");
    await assert.rejects(recoverRunLock(folder, { expectedRevision: view.revision, expectedFileIdentity: view.fileIdentity, expectedNonce: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", actor: "test", reason: "not proof" }), { code: "RUN_LOCK_LEGACY" });
    assert.equal(await readFile(join(folder, ".write.lock"), "utf8"), contents);
  }
  assert.equal(calls, 0);
});
test("legacy writer holding an empty lock excludes new writer", async t => {
  const folder = await fixture(t); const old = await open(join(folder, ".write.lock"), "wx");
  try { await assert.rejects(withRunLock(folder, async () => assert.fail("overlap")), { code: "RUN_LOCK_OCCUPIED" }); }
  finally { await old.close(); await unlink(join(folder, ".write.lock")); }
  await withRunLock(folder, async () => {});
});
test("separate processes serialize callbacks through the same gate", async t => {
  const folder = await fixture(t);
  const children = Array.from({ length: 4 }, () => child(folder, `await withRunLock(folder,async()=>{await appendFile(folder+'/events',process.pid+':start\\n');await new Promise(r=>setTimeout(r,80));await appendFile(folder+'/events',process.pid+':end\\n');});`));
  for (const c of children) { const [code] = await c.exit; assert.equal(code, 0, c.errors()); }
  const rows = (await readFile(join(folder, "events"), "utf8")).trim().split("\n"); assert.equal(rows.length, 8);
  for (let i = 0; i < rows.length; i += 2) assert.equal(rows[i].replace(":start", ":end"), rows[i + 1]);
});
test("live owner excludes recovery at OS fence without changing its lock", async t => {
  const folder = await fixture(t); const c = child(folder, "await withRunLock(folder,async()=>{process.send('held');await new Promise(()=>{setInterval(()=>{},1000);});});");
  t.after(() => c.proc.kill()); await once(c.proc, "message");
  const view = await inspectRunLock(folder); const before = await readFile(join(folder, ".write.lock")); const started = Date.now();
  await assert.rejects(recoverRunLock(folder, recovery(view)), { code: "RUN_LOCK_BUSY" }); assert.ok(Date.now() - started < 5000);
  assert.deepEqual(await readFile(join(folder, ".write.lock")), before); c.proc.kill(); await c.exit;
});
test("killed owner requires exact explicit recovery and durable evidence", async t => {
  const folder = await fixture(t); const view = await crashed(t, folder);
  await assert.rejects(withRunLock(folder, async () => assert.fail("automatic recovery")), { code: "RUN_LOCK_OCCUPIED" });
  await assert.rejects(recoverRunLock(folder, { ...recovery(view), expectedRevision: "0".repeat(64) }), { code: "RUN_LOCK_CHANGED" });
  await assert.rejects(recoverRunLock(folder, { ...recovery(view), expectedNonce: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }), { code: "RUN_LOCK_CHANGED" });
  const applied = await recoverRunLock(folder, recovery(view)); const audit = JSON.parse(await readFile(applied.audit, "utf8"));
  assert.equal(applied.applied, true); assert.equal(audit.revision, view.revision); assert.equal(audit.owner.nonce, view.owner.nonce);
  assert.equal(audit.proof, "exclusive-original-sqlite-gate"); assert.equal((await inspectRunLock(folder)).state, "absent");
  await assert.rejects(recoverRunLock(folder, recovery(view)), { code: "RUN_LOCK_LEGACY" }); await withRunLock(folder, async () => {});
});
test("PID reuse is not a recovery proof; only the original exclusive gate is", async t => {
  const folder = await fixture(t); await crashed(t, folder); const path = join(folder, ".write.lock");
  const owner = JSON.parse(await readFile(path)); owner.pid = process.pid; await writeFile(path, JSON.stringify(owner));
  await recoverRunLock(folder, recovery(await inspectRunLock(folder))); assert.equal((await inspectRunLock(folder)).state, "absent");
});
test("wrong host or missing/replaced gate rejects recovery", async t => {
  const folder = await fixture(t); await crashed(t, folder); const path = join(folder, ".write.lock"); const original = await readFile(path, "utf8");
  const owner = JSON.parse(original); owner.host = "not-this-host"; await writeFile(path, JSON.stringify(owner));
  await assert.rejects(recoverRunLock(folder, recovery(await inspectRunLock(folder))), { code: "RUN_LOCK_CHANGED" });
  await writeFile(path, original); const view = await inspectRunLock(folder); await unlink(join(folder, ".write-gate.sqlite"));
  await assert.rejects(recoverRunLock(folder, recovery(view)), { code: "RUN_LOCK_GATE_MISSING" });
  await assert.rejects(withRunLock(folder, async () => {}), { code: "RUN_LOCK_OCCUPIED" });
  await assert.rejects(recoverRunLock(folder, recovery(view)), { code: "RUN_LOCK_CHANGED" });
});
test("replacement is preserved and cleanup failure reports successful action", async t => {
  const folder = await fixture(t);
  await assert.rejects(withRunLock(folder, async () => { await unlink(join(folder, ".write.lock")); await writeFile(join(folder, ".write.lock"), "replacement"); return "committed"; }), error => error.code === "RUN_LOCK_CLEANUP" && error.actionSucceeded === true && error.result === "committed" && error.cleanupError.code === "RUN_LOCK_CHANGED");
  assert.equal(await readFile(join(folder, ".write.lock"), "utf8"), "replacement");
});
test("action error remains cause when replacement prevents cleanup", async t => {
  const folder = await fixture(t); const expected = new Error("action-failure");
  await assert.rejects(withRunLock(folder, async () => { await unlink(join(folder, ".write.lock")); await writeFile(join(folder, ".write.lock"), "replacement"); throw expected; }), error => error.code === "RUN_LOCK_CLEANUP" && error.actionSucceeded === false && error.cause === expected && error.actionError === expected);
});
test("crash after side effect does not imply rollback or repeat action", async t => {
  const folder = await fixture(t); const view = await crashed(t, folder, "await writeFile(folder+'/applied','yes');process.send('applied');await new Promise(()=>{setInterval(()=>{},1000);});");
  await recoverRunLock(folder, recovery(view)); assert.equal(await readFile(join(folder, "applied"), "utf8"), "yes");
  assert.equal((await readdir(folder)).filter(name => name.endsWith(".completed.json")).length, 1);
});

const clearing = view => ({ expectedRevision: view.revision, expectedFileIdentity: view.fileIdentity, actor: "test-author", reason: "Empty lock left by a crashed write" });
const later = () => Date.now() + LEGACY_LOCK_MIN_AGE_MS + 60_000;
test("an empty lock untouched for 30 minutes is cleared once, with evidence, and the run is writable again", async t => {
  const folder = await fixture(t); await writeFile(join(folder, ".write.lock"), "");
  const view = await inspectRunLock(folder); assert.equal(view.state, "legacy");
  await assert.rejects(clearLegacyRunLock(folder, clearing(view)), { code: "RUN_LOCK_RECENT" });
  assert.equal((await inspectRunLock(folder)).state, "legacy", "a lock set moments ago stays");
  const result = await clearLegacyRunLock(folder, clearing(view), later);
  assert.equal(result.applied, true); assert.equal((await inspectRunLock(folder)).state, "absent");
  const evidence = JSON.parse(await readFile(result.audit, "utf8"));
  assert.equal(evidence.proof, "exclusive-gate-empty-lock-untouched-30-minutes-no-running-agent"); assert.equal(evidence.actor, "test-author"); assert.equal(evidence.owner, null);
  assert.equal((await readdir(folder)).filter(name => name.endsWith(".completed.json")).length, 1);
  await assert.rejects(clearLegacyRunLock(folder, clearing(view), later), { code: "RUN_LOCK_ABSENT" });
  assert.equal(await withRunLock(folder, async () => "written"), "written");
});
test("clearing refuses a lock with content, a lock changed since inspect, and incomplete input", async t => {
  const folder = await fixture(t);
  // A bare ID, as an older recovery path writes: unknown content is left for a person.
  await writeFile(join(folder, ".write.lock"), "11111111-1111-4111-8111-111111111111");
  const unknown = await inspectRunLock(folder); assert.equal(unknown.state, "unknown");
  await assert.rejects(clearLegacyRunLock(folder, clearing(unknown), later), { code: "RUN_LOCK_NOT_LEGACY" });
  await unlink(join(folder, ".write.lock")); await writeFile(join(folder, ".write.lock"), "");
  await assert.rejects(clearLegacyRunLock(folder, clearing(unknown), later), { code: "RUN_LOCK_CHANGED" });
  await assert.rejects(clearLegacyRunLock(folder, { ...clearing(await inspectRunLock(folder)), reason: " " }, later), { code: "RUN_LOCK_INPUT" });
  assert.equal(await readFile(join(folder, ".write.lock"), "utf8"), "");
});
test("a live owner holding the gate stops clearing without touching its lock", async t => {
  const folder = await fixture(t); const c = child(folder, "await withRunLock(folder,async()=>{process.send('held');await new Promise(()=>{setInterval(()=>{},1000);});});");
  t.after(() => c.proc.kill()); await once(c.proc, "message");
  const view = await inspectRunLock(folder); const before = await readFile(join(folder, ".write.lock"));
  await assert.rejects(clearLegacyRunLock(folder, clearing(view), later), { code: "RUN_LOCK_BUSY" });
  assert.deepEqual(await readFile(join(folder, ".write.lock")), before); c.proc.kill(); await c.exit;
});
test("running agents in a workspace come from the host's list, background workspaces included and the caller left out", async () => {
  const filters = [];
  const pages = [
    [{ agent: { id: "me", workspaceId: "wks_run", status: "running" } }, { agent: { id: "a1", title: "Builder", workspaceId: "wks_run", status: "running" } }, { agent: { id: "a2", workspaceId: "wks_other", status: "running" } }],
    [{ agent: { id: "a3", workspaceId: "wks_run", status: "idle" } }, { agent: { id: "a4", workspaceId: "wks_run", status: "initializing" } }, { agent: { id: "a5", workspaceId: "wks_run", status: "running", archivedAt: "2026-11-01T00:00:00Z" } }],
  ];
  const paseo = { agents: { list: async ({ filter, page }) => { filters.push(filter); const index = page.cursor ? 1 : 0; return { entries: pages[index], pageInfo: { hasMore: index === 0, nextCursor: index === 0 ? "next" : null } }; } } };
  assert.deepEqual(await runningAgentsInWorkspace(paseo, "wks_run", "me"), ["Builder", "a4"]);
  assert.ok(filters.length === 2 && filters.every(filter => filter.includeBackground === true));
  // A host before background workspaces is asked again without the field.
  const older = { agents: { list: async ({ filter }) => { if (filter.includeBackground) throw new Error("Update the host to use background workspaces."); return { entries: pages[0], pageInfo: { hasMore: false } }; } } };
  assert.deepEqual(await runningAgentsInWorkspace(older, "wks_run", "me"), ["Builder"]);
  const endless = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: "again" } }) } };
  await assert.rejects(runningAgentsInWorkspace(endless, "wks_run"), { code: "RUN_LOCK_AGENTS" });
  // A list that says more follow but can't be continued, or has no paging at all, isn't taken as complete.
  const stuck = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: null } }) } };
  await assert.rejects(runningAgentsInWorkspace(stuck, "wks_run"), { code: "RUN_LOCK_AGENTS", message: /gave no way to read them/ });
  const unpaged = { agents: { list: async () => ({ entries: [] }) } };
  await assert.rejects(runningAgentsInWorkspace(unpaged, "wks_run"), { code: "RUN_LOCK_AGENTS", message: /came back incomplete/ });
});

test("a run that finds an empty lock says how to clear it", async t => {
  const folder = await fixture(t); await writeFile(join(folder, ".write.lock"), "");
  assert.equal((await inspectRunLock(folder)).recovery, "clear-legacy-once-30-minutes-old-with-no-agent-running");
  await assert.rejects(withRunLock(folder, async () => assert.fail("legacy lock")), { code: "RUN_LOCK_OCCUPIED", message: /run-lock --action clear-legacy once it's 30 minutes old/ });
});
