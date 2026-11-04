import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { actionBundleSchema, actionIdentitySchema, actionSnapshotSchema, actionAuthorizationSchema, reportCompletionSchema } from "../shared/action-bundle.mjs";
import { assignmentSchema } from "./stage-records.mjs";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fold = value => process.platform === "win32" ? value.toLowerCase() : value;
const same = (a, b) => fold(resolve(a)) === fold(resolve(b));
const scopeOf = task => digest({ projectId: task.projectId, title: task.title, acceptanceCriteria: task.acceptanceCriteria });
const payload = ({ schemaVersion, taskId, runId, serverId, workspaceId, projectId, planRevision, scopeRevision, bundle }) => ({ schemaVersion, taskId, runId, serverId, workspaceId, projectId, planRevision, scopeRevision, bundle });
async function ordinary(path, directory = false) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile()) || !same(await realpath(path), path)) throw new Error("Action evidence must use ordinary files inside the task run.");
}
async function address(args, create = false) {
  const identity = actionIdentitySchema.parse(args.identity), { task } = args;
  if (task.taskId !== identity.taskId || !task.assignments?.some(a => a.serverId === identity.serverId && a.workspaceId === identity.workspaceId)) throw new Error("Action bundle task assignment does not match.");
  const folder = resolve(args.taskFolder), run = resolve(args.runFolder);
  if (basename(folder) !== identity.taskId || !same(run, join(folder, "runs", identity.runId))) throw new Error("Action bundle must belong to the selected task run.");
  await ordinary(folder, true); await ordinary(join(folder, "runs"), true); await ordinary(run, true);
  const actions = join(run, "actions");
  if (create) await mkdir(actions, { recursive: false }).catch(error => { if (error.code !== "EEXIST") throw error; });
  try { await ordinary(actions, true); } catch (error) { if (error.code === "ENOENT" && !create) return { identity, actions, missing: true }; throw error; }
  return { identity, actions, missing: false };
}
async function readJson(file) { await ordinary(file); return JSON.parse(await readFile(file, "utf8")); }
async function atomicJson(file, value) {
  try { await ordinary(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  await rename(temp, file);
}
function checkedSnapshot(raw, args, identity) {
  const snapshot = actionSnapshotSchema.parse(raw);
  for (const key of Object.keys(identity)) if (snapshot[key] !== identity[key]) throw new Error("Action bundle identity changed.");
  const scopeMatch = snapshot.projectId === args.task.projectId && snapshot.scopeRevision === scopeOf(args.task);
  if (!scopeMatch && !args.allowStaleScope) throw new Error("Task scope changed after preparing the action bundle.");
  if (args.planRevision && snapshot.planRevision !== args.planRevision) throw new Error("The action bundle belongs to a different plan revision.");
  if (snapshot.revision !== digest(payload(snapshot))) throw new Error("Action bundle content does not match its revision.");
  return { ...snapshot, kind: snapshot.bundle.kind, summary: snapshot.bundle.summary, scopeMatch };
}
export async function readActionBundle(args) {
  const { identity, actions, missing } = await address(args);
  if (missing) return null;
  let pointer;
  try { pointer = await readJson(join(actions, "current.json")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (Object.keys(pointer).join() !== "revision" || !/^[a-f0-9]{64}$/.test(pointer.revision)) throw new Error("Action bundle pointer is invalid.");
  const snapshot = checkedSnapshot(await readJson(join(actions, `bundle-${pointer.revision}.json`)), args, identity);
  if (snapshot.revision !== pointer.revision) throw new Error("Action bundle pointer does not match its immutable snapshot.");
  return snapshot;
}
// Called under the existing run lock after native managed-agent verification.
export async function saveActionBundle(args) {
  const execution = assignmentSchema.parse(args.assignment);
  if (execution.workflowMode !== "automatic" || execution.execution.role !== "builder" || !["execute", "fix"].includes(execution.stage)) throw new Error("Only the assigned automatic builder may prepare an action bundle.");
  const { identity, actions } = await address(args, true);
  for (const key of Object.keys(identity)) if (execution[key] !== identity[key]) throw new Error("Action bundle worker assignment does not match.");
  const bundle = actionBundleSchema.parse(args.input);
  if (execution.deliveryKind !== bundle.kind || !execution.planRevision) throw new Error("Action bundle kind and accepted plan must match the assignment.");
  const body = payload({ schemaVersion: 1, ...identity, projectId: args.task.projectId, planRevision: execution.planRevision, scopeRevision: scopeOf(args.task), bundle });
  const revision = digest(body), file = join(actions, `bundle-${revision}.json`);
  let snapshot = actionSnapshotSchema.parse({ ...body, revision, createdAt: new Date().toISOString() });
  try { await writeFile(file, JSON.stringify(snapshot, null, 2) + "\n", { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; const existing = await readJson(file); checkedSnapshot(existing, { ...args, planRevision: execution.planRevision }, identity); snapshot = actionSnapshotSchema.parse(existing); }
  await atomicJson(join(actions, "current.json"), { revision });
  return { ...snapshot, kind: bundle.kind, summary: bundle.summary };
}
export async function readActionAuthorization(args) {
  const { identity, actions, missing } = await address(args);
  if (missing) return null;
  let raw; try { raw = await readJson(join(actions, "authorization.json")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const authorization = actionAuthorizationSchema.parse(raw);
  for (const key of Object.keys(identity)) if (authorization[key] !== identity[key]) throw new Error("Action authorization identity does not match.");
  if (authorization.resumeState === "completed") {
    const bundle = await readActionBundle({ ...args, planRevision: authorization.planRevision });
    if (!bundle || bundle.revision !== authorization.revision) throw new Error("Completed action receipt belongs to a different current bundle.");
    for (const evidence of authorization.completion.evidence) {
      const actual = await executionEvidence(args.runFolder, evidence.path);
      if (actual.sha256 !== evidence.sha256 || actual.bytes !== evidence.bytes) throw new Error("Action execution evidence changed after completion.");
    }
  }
  return authorization;
}
async function executionEvidence(runFolder, path) {
  const run = resolve(runFolder), file = resolve(run, path), within = relative(run, file);
  if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) throw new Error("Execution evidence must be saved inside the current run.");
  await ordinary(file);
  const info = await lstat(file);
  if (info.size <= 0 || info.size > 4 * 1024 * 1024) throw new Error("Execution evidence must be a nonempty report smaller than 4 MiB.");
  const bytes = await readFile(file);
  return { path: within.split(sep).join("/"), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}
// Called only by the existing record command under its run lock after native builder verification.
export async function completeActionDelivery(args) {
  const prior = await readActionAuthorization(args);
  if (!prior || prior.agentId !== args.agentId || prior.revision !== args.actionRevision || !["sent", "sending", "uncertain", "completed"].includes(prior.resumeState)) throw new Error("Action completion requires the exact recorded authorization and its assigned worker.");
  if (!args.policyRevision || prior.policyRevision !== args.policyRevision) throw new Error("Current policy changed after action authorization. Reconcile the authorized execution before completing.");
  if (!args.planRevision || prior.planRevision !== args.planRevision) throw new Error("The accepted plan changed after action authorization. Reconcile the authorized execution before completing.");
  const bundle = await readActionBundle({ ...args, planRevision: prior.planRevision });
  if (!bundle || bundle.kind !== "actions" || bundle.revision !== prior.revision) throw new Error("The authorized actions changed before recording completion.");
  if (prior.resumeState === "completed") return prior;
  if (!Array.isArray(args.evidence) || !args.evidence.length || args.evidence.length > 30) throw new Error("Action completion requires actual execution and verification evidence.");
  const evidence = await Promise.all(args.evidence.map(path => executionEvidence(args.runFolder, path)));
  const { schemaVersion, taskId, runId, serverId, workspaceId, ...value } = prior;
  return saveActionAuthorization(args, { ...value, resumeState: "completed", completion: { completedAt: new Date().toISOString(), summary: args.summary, evidence, ...(["sending", "uncertain"].includes(prior.resumeState) ? { reconciledFrom: prior.resumeState } : {}) } });
}
export const reportEvidenceRevision = checkpoints => digest(checkpoints);
export async function readReportCompletion(args) {
  const { identity, actions, missing } = await address(args);
  if (missing) return null;
  let pointer;
  try { pointer = await readJson(join(actions, "report-current.json")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (Object.keys(pointer).join() !== "fingerprint" || !/^[a-f0-9]{64}$/.test(pointer.fingerprint)) throw new Error("Report completion pointer is invalid.");
  const receipt = reportCompletionSchema.parse(await readJson(join(actions, `report-completion-${pointer.fingerprint}.json`)));
  for (const key of Object.keys(identity)) if (receipt[key] !== identity[key]) throw new Error("Report completion identity changed.");
  if (receipt.fingerprint !== pointer.fingerprint) throw new Error("Report completion pointer does not match its immutable receipt.");
  const bundle = await readActionBundle(args);
  // A revised report may earn a new receipt after fresh review. Old receipts remain immutable history.
  if (!bundle || bundle.scopeMatch === false || bundle.kind !== "report" || bundle.revision !== receipt.revision || bundle.planRevision !== receipt.planRevision) return null;
  if (args.policyRevision && args.policyRevision !== receipt.policyRevision || args.checkpointDigest && args.checkpointDigest !== receipt.checkpointDigest) return null;
  return receipt;
}
// Caller holds the run lock and has rebuilt current validation and both independent reviews.
export async function saveReportCompletion(args, value) {
  const { identity, actions } = await address(args, true);
  const receipt = reportCompletionSchema.parse({ schemaVersion: 1, ...identity, ...value });
  for (const key of Object.keys(identity)) if (receipt[key] !== identity[key]) throw new Error("Report completion identity changed.");
  const bundle = await readActionBundle({ ...args, planRevision: receipt.planRevision });
  if (!bundle || bundle.kind !== "report" || bundle.revision !== receipt.revision) throw new Error("The reviewed report changed before recording completion.");
  const file = join(actions, `report-completion-${receipt.fingerprint}.json`);
  let saved = receipt;
  try { await writeFile(file, JSON.stringify(receipt, null, 2) + "\n", { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    saved = reportCompletionSchema.parse(await readJson(file));
    if (digest({ ...saved, completedAt: null }) !== digest({ ...receipt, completedAt: null })) throw new Error("The saved report receipt changed.");
  }
  await atomicJson(join(actions, "report-current.json"), { fingerprint: receipt.fingerprint });
  return saved;
}
// The authenticated human action handler owns the run lock and revalidates readiness before calling.
export async function saveActionAuthorization(args, value) {
  const { identity, actions } = await address(args, true);
  const authorization = actionAuthorizationSchema.parse({ schemaVersion: 1, ...identity, ...value });
  for (const key of Object.keys(identity)) if (authorization[key] !== identity[key]) throw new Error("Action authorization identity does not match.");
  const bundle = await readActionBundle({ ...args, planRevision: authorization.planRevision });
  if (!bundle || bundle.kind !== "actions" || bundle.revision !== authorization.revision) throw new Error("Action bundle changed before authorization was saved.");
  const previous = await readActionAuthorization(args);
  if (previous && previous.fingerprint !== authorization.fingerprint) throw new Error("An earlier action authorization needs reconciliation before authorizing another bundle.");
  await atomicJson(join(actions, "authorization.json"), authorization);
  return authorization;
}
