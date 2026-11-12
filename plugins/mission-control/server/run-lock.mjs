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
  return { state, revision: current.revision, fileIdentity: current.fileIdentity, owner: current.owner, recovery: state === "owned-unverified" ? "requires-exclusive-gate-and-exact-match" : "blocked-external-writer-exclusion-required" };
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
      throw fail("RUN_LOCK_OCCUPIED", `Run lock is ${observed.state}; no action was started. Use run-lock inspect. Legacy or unknown locks require proven external writer exclusion.`, { observed });
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
