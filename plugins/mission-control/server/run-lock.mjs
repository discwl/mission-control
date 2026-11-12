import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

const protocol = "mc-run-lock-v1";
const lockName = ".write.lock";
const gateName = ".write-gate.sqlite";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const runKey = folder => process.platform === "win32" ? folder.toLowerCase() : folder;
const processInstance = randomUUID();

export class RunLockError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = "RunLockError"; this.code = code; Object.assign(this, details); }
}
const fail = (code, message, details) => new RunLockError(code, message, details);
function regular(stat) { return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n; }
// Windows lstat reports dev=0 while fstat reports the volume; compare within the canonical run.
function identity(stat) { return `${process.platform === "win32" ? "win" : stat.dev}:${stat.ino}:${stat.birthtimeNs}`; }
function ownerOf(bytes, folder) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (Object.keys(value).sort().join() !== "acquiredAt,gateId,host,nonce,pid,processInstance,protocol,run" || value.protocol !== protocol || value.run !== runKey(folder) || !uuid(value.nonce) || !uuid(value.gateId) || !uuid(value.processInstance) || typeof value.host !== "string" || !value.host || value.host.length > 256 || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.acquiredAt !== "string" || !Number.isFinite(Date.parse(value.acquiredAt))) return null;
    return value;
  } catch { return null; }
}
async function snapshot(folder) {
  const file = join(folder, lockName);
  let stat;
  try { stat = await lstat(file, { bigint: true }); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!regular(stat) || stat.size > 8192) throw fail("RUN_LOCK_UNSAFE", "Run lock is not a small regular single-link file.");
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!regular(opened) || identity(opened) !== identity(stat)) throw fail("RUN_LOCK_CHANGED", "Run lock changed during inspection.");
    const bytes = await handle.readFile();
    if (bytes.length > 8192 || identity(await lstat(file, { bigint: true })) !== identity(opened)) throw fail("RUN_LOCK_CHANGED", "Run lock changed during inspection.");
    return { bytes, fileIdentity: identity(opened), revision: hash(bytes), owner: ownerOf(bytes, folder) };
  } finally { await handle.close(); }
}

/** Read-only observation, NOT a lease/liveness assertion or permission to delete a lock. */
export async function inspectRunLock(runFolder) {
  const folder = await realpath(runFolder);
  const current = await snapshot(folder);
  if (!current) return { state: "absent", revision: null, fileIdentity: null, owner: null, recovery: "none" };
  const state = current.bytes.length === 0 ? "legacy" : current.owner ? "owned-unverified" : "unknown";
  const recovery = state === "owned-unverified" ? "requires-exclusive-gate-and-exact-match" : state === "legacy" ? "clear-legacy-once-30-minutes-old-with-no-agent-running" : "blocked-external-writer-exclusion-required";
  return { state, revision: current.revision, fileIdentity: current.fileIdentity, owner: current.owner, recovery };
}

// Same-process SQLite transactions provide OS-backed exclusion across CLI/plugin instances.
// Never delete/replace this database. No PID, timestamp or stale-file heuristic grants admission.
// The filesystem must provide local SQLite locking semantics; shared/network vaults are unsupported.
async function gate(folder, { create = true, attempts = 20, intervalMs = 50 } = {}) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); }
  catch (cause) { throw fail("RUN_LOCK_RUNTIME", "Run locking requires a runtime with node:sqlite; no action was started.", { cause }); }
  const path = join(folder, gateName);
  if (create) {
    try { const file = await open(path, "wx", 0o600); await file.close(); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  let stat;
  try { stat = await lstat(path, { bigint: true }); } catch (error) { if (error.code === "ENOENT") throw fail("RUN_LOCK_GATE_MISSING", "The original run-lock gate is missing; recovery is blocked."); throw error; }
  if (!regular(stat)) throw fail("RUN_LOCK_UNSAFE", "Run-lock gate must be a regular single-link file.");
  const db = new DatabaseSync(path);
  let held = false;
  try {
    db.exec("PRAGMA busy_timeout=0");
    for (let attempt = 0; ; attempt++) {
      try { db.exec("BEGIN IMMEDIATE"); held = true; break; }
      catch (error) {
        if (![5, 6].includes(error.errcode)) throw fail("RUN_LOCK_GATE_FAILURE", "Run-lock storage failed; no action was started. This does not establish a busy writer. Inspect the storage error before retrying.", { cause: error });
        if (attempt >= attempts) throw fail("RUN_LOCK_BUSY", "This run is being updated. No action was started; inspect before retrying.", { cause: error });
        await delay(intervalMs);
      }
    }
    if (identity(await lstat(path, { bigint: true })) !== identity(stat)) throw fail("RUN_LOCK_GATE_CHANGED", "Run-lock gate identity changed.");
    if (create) {
      db.exec("CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL)");
      db.prepare("INSERT OR IGNORE INTO identity(id,token) VALUES (1,?)").run(randomUUID());
      // Persist the gate identity before any lock metadata can refer to it. No protected callback yet.
      db.exec("COMMIT"); held = false;
      for (let attempt = 0; ; attempt++) {
        try { db.exec("BEGIN IMMEDIATE"); held = true; break; }
        catch (error) {
          if (![5, 6].includes(error.errcode)) throw fail("RUN_LOCK_GATE_FAILURE", "Run-lock storage failed; no action was started. This does not establish a busy writer. Inspect the storage error before retrying.", { cause: error });
          if (attempt >= attempts) throw fail("RUN_LOCK_BUSY", "This run is being updated. No action was started.", { cause: error });
          await delay(intervalMs);
        }
      }
    }
    if (identity(await lstat(path, { bigint: true })) !== identity(stat)) throw fail("RUN_LOCK_GATE_CHANGED", "Run-lock gate identity changed.");
    const token = db.prepare("SELECT token FROM identity WHERE id=1").get()?.token;
    if (!uuid(token)) throw fail("RUN_LOCK_GATE_INVALID", "Run-lock gate identity is invalid.");
    return { token, async close() { try { if (held) { db.exec("ROLLBACK"); held = false; } } finally { db.close(); } } };
  } catch (error) { try { if (held) db.exec("ROLLBACK"); } finally { db.close(); } throw error; }
}

async function retryCleanup(action) {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) { if (!["EBUSY", "EPERM", "EACCES"].includes(error.code) || attempt >= 5) throw error; await delay(25); }
  }
}
async function removeExact(folder, expected) {
  // All new release/recovery/acquire operations hold the same OS gate. Old writers only create
  // with wx while this path is absent; they cannot replace our occupied lock. Out-of-protocol
  // private edits cannot be made safe by a check-then-unlink and are never a recovery procedure.
  await retryCleanup(async () => {
    const current = await snapshot(folder);
    if (!current || current.fileIdentity !== expected.fileIdentity || current.revision !== expected.revision) throw fail("RUN_LOCK_CHANGED", "Run lock ownership changed; the replacement was left untouched.");
    await unlink(join(folder, lockName));
  });
}

export async function withRunLock(runFolder, action) {
  const folder = await realpath(runFolder);
  const fence = await gate(folder);
  let file, owned, result, actionError, cleanupError, started = false, failed = false;
  try {
    try { file = await open(join(folder, lockName), "wx", 0o600); }
    catch (cause) {
      if (cause.code !== "EEXIST") throw cause;
      const observed = await inspectRunLock(folder);
      const next = observed.state === "legacy" ? "An empty lock left by an interrupted write can be cleared with run-lock --action clear-legacy once it's 30 minutes old and no other agent is running in the workspace." : "Legacy or unknown locks require proven external writer exclusion.";
      throw fail("RUN_LOCK_OCCUPIED", `Run lock is ${observed.state}; no action was started. Use run-lock inspect. ${next}`, { observed });
    }
    const owner = { protocol, run: runKey(folder), nonce: randomUUID(), gateId: fence.token, host: hostname(), pid: process.pid, processInstance, acquiredAt: new Date().toISOString() };
    const bytes = Buffer.from(JSON.stringify(owner));
    await file.writeFile(bytes); await file.sync();
    owned = { fileIdentity: identity(await file.stat({ bigint: true })), revision: hash(bytes) };
    started = true;
    try { result = await action(); } catch (error) { actionError = error; failed = true; }
  } catch (error) { actionError = error; failed = true; }
  finally {
    try {
      if (file) await retryCleanup(() => file.close());
      // Incomplete initialization is unknown, not a candidate for guessed cleanup.
      if (owned) await removeExact(folder, owned);
    } catch (error) { cleanupError = error; }
    try { await fence.close(); } catch (error) { cleanupError ??= error; }
  }
  if (cleanupError) throw fail("RUN_LOCK_CLEANUP", started ? "Run action finished or failed before lock cleanup failed. Read back the action result before any retry." : "Lock setup failed and cleanup is unconfirmed. No action was started.", { cause: actionError ?? cleanupError, actionStarted: started, actionSucceeded: started && !failed, actionError, cleanupError, result });
  if (failed) throw actionError;
  return result;
}

/** Explicit recovery ONLY for a complete owner record created by this protocol. */
export async function recoverRunLock(runFolder, input) {
  if (!input || !/^[a-f0-9]{64}$/.test(input.expectedRevision ?? "") || typeof input.expectedFileIdentity !== "string" || !uuid(input.expectedNonce) || typeof input.actor !== "string" || !input.actor.trim() || input.actor.length > 200 || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000) throw fail("RUN_LOCK_INPUT", "Recovery needs exact revision, file identity, owner nonce, actor and reason.");
  const folder = await realpath(runFolder);
  const fence = await gate(folder, { create: false });
  try {
    const current = await snapshot(folder);
    if (!current || !current.owner) throw fail("RUN_LOCK_LEGACY", "Legacy, absent or unknown lock cannot be recovered. External writer exclusion is required.");
    if (current.owner.gateId !== fence.token || current.owner.host !== hostname() || current.revision !== input.expectedRevision || current.fileIdentity !== input.expectedFileIdentity || current.owner.nonce !== input.expectedNonce) throw fail("RUN_LOCK_CHANGED", "Run lock/gate/host identity changed; recovery refused.");
    // BEGIN IMMEDIATE is the proof that no cooperating owner still holds its callback fence.
    // PID and processInstance are audit context only, so PID reuse never certifies abandonment.
    const id = randomUUID();
    const evidence = { schemaVersion: 1, id, at: new Date().toISOString(), actor: input.actor, reason: input.reason, run: runKey(folder), revision: current.revision, fileIdentity: current.fileIdentity, owner: current.owner, originalBase64: current.bytes.toString("base64"), proof: "exclusive-original-sqlite-gate", outcome: "prepared" };
    const audit = join(folder, `.write-recovery-${id}.json`);
    const before = await open(audit, "wx", 0o600);
    try { await before.writeFile(JSON.stringify(evidence, null, 2)); await before.sync(); } finally { await before.close(); }
    await removeExact(folder, current);
    try {
      const completed = await open(join(folder, `.write-recovery-${id}.completed.json`), "wx", 0o600);
      try { await completed.writeFile(JSON.stringify({ id, at: new Date().toISOString(), outcome: "removed", revision: current.revision })); await completed.sync(); } finally { await completed.close(); }
    } catch (cause) {
      throw fail("RUN_LOCK_RECOVERY_AUDIT", "Lock removed, but completion audit could not be confirmed. Inspect before any further action; do not repeat recovery.", { cause, applied: true, audit, revision: current.revision });
    }
    return { applied: true, audit, revision: current.revision };
  } finally { await fence.close(); }
}

export const LEGACY_LOCK_MIN_AGE_MS = 30 * 60_000;

/**
 * Explicit clearing of an EMPTY lock: what a writer from before this protocol leaves when it dies mid-write, or a
 * writer of this protocol if it dies between creating the lock and recording its owner. With no owner record nothing
 * proves that writer is gone, so this is the one place a timestamp decides, by the user's explicit choice:
 * - the exclusive gate excludes every writer of this protocol;
 * - a legacy writer holds its lock only while its write runs, so an empty lock untouched for 30 minutes isn't one in use;
 * - the caller must first check that no agent is running in the run's workspace (`runningAgentsInWorkspace`).
 * The lock must still match what `inspectRunLock` returned. Evidence is saved as for `recoverRunLock`.
 */
export async function clearLegacyRunLock(runFolder, input, now = Date.now) {
  if (!input || !/^[a-f0-9]{64}$/.test(input.expectedRevision ?? "") || typeof input.expectedFileIdentity !== "string" || typeof input.actor !== "string" || !input.actor.trim() || input.actor.length > 200 || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000) throw fail("RUN_LOCK_INPUT", "Clearing needs the exact revision and file identity from inspect, an actor and a reason.");
  const folder = await realpath(runFolder);
  const fence = await gate(folder);
  try {
    const current = await snapshot(folder);
    if (!current) throw fail("RUN_LOCK_ABSENT", "There is no run lock to clear.");
    if (current.bytes.length !== 0) throw fail("RUN_LOCK_NOT_LEGACY", "Only an empty lock can be cleared this way. A lock with an owner record needs recover; any other content is left for a person to inspect.");
    if (current.revision !== input.expectedRevision || current.fileIdentity !== input.expectedFileIdentity) throw fail("RUN_LOCK_CHANGED", "Run lock changed since inspect; clearing refused.");
    const modified = Number((await lstat(join(folder, lockName), { bigint: true })).mtimeMs);
    if (!(now() - modified >= LEGACY_LOCK_MIN_AGE_MS)) throw fail("RUN_LOCK_RECENT", "The lock was set less than 30 minutes ago, so a write may still hold it; clearing refused.", { modifiedAt: new Date(modified).toISOString() });
    const id = randomUUID();
    const evidence = { schemaVersion: 1, id, at: new Date().toISOString(), actor: input.actor, reason: input.reason, run: runKey(folder), revision: current.revision, fileIdentity: current.fileIdentity, owner: null, lockModifiedAt: new Date(modified).toISOString(), originalBase64: "", proof: "exclusive-gate-empty-lock-untouched-30-minutes-no-running-agent", outcome: "prepared" };
    const audit = join(folder, `.write-recovery-${id}.json`);
    const before = await open(audit, "wx", 0o600);
    try { await before.writeFile(JSON.stringify(evidence, null, 2)); await before.sync(); } finally { await before.close(); }
    await removeExact(folder, current);
    try {
      const completed = await open(join(folder, `.write-recovery-${id}.completed.json`), "wx", 0o600);
      try { await completed.writeFile(JSON.stringify({ id, at: new Date().toISOString(), outcome: "removed", revision: current.revision })); await completed.sync(); } finally { await completed.close(); }
    } catch (cause) {
      throw fail("RUN_LOCK_RECOVERY_AUDIT", "Lock removed, but completion audit could not be confirmed. Inspect before any further action; do not repeat clearing.", { cause, applied: true, audit, revision: current.revision });
    }
    return { applied: true, audit, revision: current.revision };
  } finally { await fence.close(); }
}

/**
 * Agents still running or starting in a workspace, other than `exclude` (the caller), from the host's agent list.
 * Agents in background workspaces are included where the host has them. On a Paseo 0.16 host, background agents in an
 * ordinary workspace (short helpers, or agents started by a background agent) stay hidden from the 0.15 client this runs
 * with, so they aren't counted. This list is an extra check; the 30-minute rule in `clearLegacyRunLock` doesn't rely on
 * it. An incomplete list, or too many agents to page through, is refused, not guessed.
 */
export async function runningAgentsInWorkspace(paseo, workspaceId, exclude = null) {
  const running = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const list = filter => paseo.agents.list({ filter, sort: [{ key: "created_at", direction: "desc" }], page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    let result;
    try { result = await list({ includeBackground: true }); }
    catch (error) {
      if (!/update the host to use background workspaces/i.test(String(error?.message ?? error))) throw error;
      result = await list({});
    }
    if (!Array.isArray(result?.entries) || !result.pageInfo) throw fail("RUN_LOCK_AGENTS", "Paseo's agent list came back incomplete, so it isn't known that no agent is running in this workspace; clearing refused.");
    for (const { agent } of result.entries) {
      if (agent.workspaceId === workspaceId && agent.id !== exclude && !agent.archivedAt && ["running", "initializing"].includes(agent.status)) running.push(agent.title || agent.id);
    }
    if (!result.pageInfo.hasMore) return running;
    cursor = result.pageInfo.nextCursor;
    if (!cursor) throw fail("RUN_LOCK_AGENTS", "Paseo said more agents follow but gave no way to read them, so it isn't known that no agent is running in this workspace; clearing refused.");
  }
  throw fail("RUN_LOCK_AGENTS", "Too many agents to confirm none is running in this workspace; clearing refused.");
}
