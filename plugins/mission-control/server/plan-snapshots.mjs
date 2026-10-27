import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { normalizePlanBrief } from "../shared/plan-brief.mjs";

const snapshotName = /^(decision_[a-f0-9-]+)\.([a-f0-9]{64})\.json$/;
const runName = /^run_[a-f0-9-]+$/;
const hash = text => createHash("sha256").update(text).digest("hex");
const inside = (root, file) => { const path = relative(root, file); return !path || (path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path)); };

async function regular(file, limit = 200_000) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Plans must be regular files, not links.");
  if (info.size > limit * 4) throw new Error("Plan is too large to review safely.");
  const text = await readFile(file, "utf8");
  if (text.length > limit) throw new Error("Plan is too large to review safely.");
  return text;
}

async function folders(taskFolder, runFolder) {
  const task = await realpath(taskFolder);
  const runs = await realpath(join(task, "runs"));
  const run = await realpath(runFolder);
  if (!inside(task, runs) || !inside(runs, run) || run === runs) throw new Error("Plan run escapes its task.");
  return { task, run, runs };
}

async function currentPlan(task) {
  try {
    const markdown = await regular(join(task, "plan.md"));
    if (!markdown.trim()) return null;
    return { markdown, documentRevision: hash(markdown) };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function validateSnapshot(value, taskId, runId, decisionId) {
  if (value?.schemaVersion !== 1 || value.taskId !== taskId || value.runId !== runId || value.decisionId !== decisionId
    || typeof value.markdown !== "string" || !value.markdown.trim() || value.markdown.length > 200_000
    || !Number.isFinite(Date.parse(value.requestedAt))) throw new Error("Saved plan identity or content is invalid.");
  const brief = normalizePlanBrief(value.brief);
  if (value.previous !== null && (!/^[a-f0-9]{64}$/.test(value.previous?.revision) || !/^[a-f0-9]{64}$/.test(value.previous?.documentRevision)
    || !Number.isFinite(Date.parse(value.previous?.requestedAt)))) throw new Error("Saved previous plan is invalid.");
  const previous = value.previous ? { ...value.previous, brief: normalizePlanBrief(value.previous.brief) } : null;
  return { ...value, brief, previous };
}

async function savedPlan(task, run, taskId, runId, name) {
  const match = snapshotName.exec(name);
  if (!match) throw new Error("Invalid saved plan reference.");
  const plans = await realpath(join(run, "plans"));
  if (!inside(run, plans)) throw new Error("Saved plans escape the run.");
  const raw = await regular(join(plans, name), 1_000_000);
  if (hash(raw) !== match[2]) throw new Error("Saved plan changed. Ask for a new proposal.");
  const snapshot = validateSnapshot(JSON.parse(raw), taskId, runId, match[1]);
  return { ...snapshot, revision: match[2], documentRevision: hash(snapshot.markdown) };
}

async function previousPlan(task, runs, taskId) {
  const names = (await readdir(runs)).filter(name => runName.test(name));
  if (names.length > 200) throw new Error("Plan history exceeds the review limit; archive old runs before requesting a new plan.");
  const history = [];
  let scanned = 0;
  for (const runId of names) {
    const run = await realpath(join(runs, runId));
    if (!inside(runs, run)) throw new Error("Plan history escapes the task.");
    let files;
    try {
      const plans = await realpath(join(run, "plans"));
      if (!inside(run, plans)) throw new Error("Plan history escapes the run.");
      files = (await readdir(plans)).filter(name => snapshotName.test(name));
    }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    scanned += files.length;
    if (scanned > 500) throw new Error("Plan history exceeds the review limit.");
    for (const name of files) {
      const match = snapshotName.exec(name);
      let record;
      try {
        const decisions = await realpath(join(run, "decisions"));
        if (!inside(run, decisions)) throw new Error("Plan decisions escape the run.");
        const text = await regular(join(decisions, `${match[1]}.md`), 40_000);
        const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
        if (!header) throw new Error("Plan decision has invalid frontmatter.");
        record = {};
        for (const line of header[1].split(/\r?\n/)) {
          const colon = line.indexOf(":");
          if (colon < 1 || Object.hasOwn(record, line.slice(0, colon))) throw new Error("Plan decision has invalid frontmatter.");
          record[line.slice(0, colon)] = JSON.parse(line.slice(colon + 1));
        }
      } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      // Interrupted requests can leave snapshots that were never proposed to the user.
      if (record.kind !== "plan" || record.taskId !== taskId || record.runId !== runId || record.decisionId !== match[1]
        || record.plan?.path !== `plans/${name}` || record.plan?.revision !== match[2]) continue;
      const saved = await savedPlan(task, run, taskId, runId, name);
      if (record.requestedAt !== saved.requestedAt || record.plan.documentRevision !== saved.documentRevision) throw new Error("Previous plan does not match its decision.");
      history.push(saved);
    }
  }
  history.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt) || b.decisionId.localeCompare(a.decisionId));
  const previous = history[0];
  return previous ? { revision: previous.revision, documentRevision: previous.documentRevision, requestedAt: previous.requestedAt, brief: previous.brief } : null;
}

/** Called by request-decision while holding the same run lock as the decision writer. */
export async function capturePlanSnapshot({ taskFolder, runFolder, taskId, runId, decisionId, requestedAt, brief }) {
  if (!/^task_[a-f0-9-]+$/.test(taskId) || !runName.test(runId) || !/^decision_[a-f0-9-]+$/.test(decisionId)) throw new Error("Invalid plan identity.");
  const { task, run, runs } = await folders(taskFolder, runFolder);
  const current = await currentPlan(task);
  if (!current) throw new Error("Write the full plan.md beside task.md before requesting plan approval.");
  const normalized = normalizePlanBrief(brief);
  if (!normalized) throw new Error("Plan approval needs a planBrief explaining the goal, behavior, scope, steps, success checks, risks and authorization.");
  const previous = await previousPlan(task, runs, taskId);
  if (previous && (previous.documentRevision !== current.documentRevision || JSON.stringify(previous.brief) !== JSON.stringify(normalized)) && !normalized.changesSincePrevious.length) throw new Error("Explain changesSincePrevious for a revised plan before requesting approval.");
  const snapshot = { schemaVersion: 1, taskId, runId, decisionId, requestedAt, markdown: current.markdown, brief: normalized, previous };
  const raw = JSON.stringify(snapshot);
  const revision = hash(raw);
  await mkdir(join(run, "plans"), { recursive: true });
  const plans = await realpath(join(run, "plans"));
  if (!inside(run, plans)) throw new Error("Saved plans escape the run.");
  const name = `${decisionId}.${revision}.json`;
  await writeFile(join(plans, name), raw, { flag: "wx" });
  return { path: `plans/${name}`, revision, documentRevision: current.documentRevision };
}

export async function readPlanSnapshot({ taskFolder, runFolder, decision }) {
  const { task, run } = await folders(taskFolder, runFolder);
  const current = await currentPlan(task);
  if (!decision.plan) return {
    source: current ? "current" : "missing", revision: null, documentRevision: current?.documentRevision ?? null,
    requestedAt: decision.requestedAt, markdown: current?.markdown ?? "", brief: null, previous: null, currentMatch: false, canApprove: false,
    warning: "This older request has no saved plan version or approval brief. The current document may differ from the proposal. Request a fresh proposal before approving.",
  };
  const expectedName = `${decision.decisionId}.${decision.plan.revision}.json`;
  if (decision.plan.path !== `plans/${expectedName}`) throw new Error("Saved plan reference does not match this decision.");
  const snapshot = await savedPlan(task, run, decision.taskId, decision.runId, expectedName);
  if (snapshot.documentRevision !== decision.plan.documentRevision || snapshot.requestedAt !== decision.requestedAt) throw new Error("Saved plan does not match the approval request.");
  const currentMatch = current?.documentRevision === snapshot.documentRevision;
  const warning = !currentMatch ? "The working plan changed after this proposal. Request a fresh proposal before approving. The saved version is shown below."
    : !snapshot.brief ? "This proposal has no readable approval brief. Request a fresh proposal." : null;
  return { source: "snapshot", revision: snapshot.revision, documentRevision: snapshot.documentRevision, requestedAt: snapshot.requestedAt,
    markdown: snapshot.markdown, brief: snapshot.brief, previous: snapshot.previous, currentMatch,
    canApprove: decision.status === "open" && !warning, warning };
}

export async function verifyPlanApproval(input, expectedPlanRevision) {
  const plan = await readPlanSnapshot(input);
  if (!plan.revision || !expectedPlanRevision || expectedPlanRevision !== plan.revision) throw new Error("Read the saved plan version before approving. Request a fresh proposal for an older decision.");
  if (!plan.currentMatch || !plan.brief) throw new Error(plan.warning || "Plan is not ready for approval.");
  return plan;
}
