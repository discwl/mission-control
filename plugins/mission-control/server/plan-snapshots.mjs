import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { normalizePlanBrief } from "../shared/plan-brief.mjs";
import { randomUUID } from "node:crypto";
import { readStageAssignments } from "./stage-records.mjs";

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
    warning: "This older request has no saved plan version or approval brief. The current document may differ from the approved scope. Recover the original approval binding if available; otherwise request explicit approval of a newly saved plan for this task. Current text, filenames and freshly computed hashes cannot establish historical approval.",
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

const automaticName = /^([a-f0-9-]{36})\.([a-f0-9]{64})\.json$/;
export function planScopeRevision(task, identity) {
  return hash(JSON.stringify([identity.taskId, identity.runId, identity.serverId, identity.workspaceId, task.hostId, task.projectId, task.title, task.acceptanceCriteria]));
}

/** Machine submissions are separate evidence: they never create a human decision or approval. */
export async function readAutomaticPlan({ taskFolder, runFolder, task: record, identity, policyRevision }) {
  const { task, run } = await folders(taskFolder, runFolder);
  let names;
  try { names = await readdir(join(run, "automatic-plans")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (names.length > 200 || names.some(name => !automaticName.test(name))) throw new Error("Invalid automatic plan history.");
  const directory = await realpath(join(run, "automatic-plans"));
  if (!inside(run, directory)) throw new Error("Automatic plans escape the run.");
  const assignments = await readStageAssignments(run, identity);
  const history = [];
  for (const name of names) {
    const raw = await regular(join(directory, name), 1_000_000); const match = automaticName.exec(name);
    if (hash(raw) !== match[2]) throw new Error("Automatic plan snapshot changed.");
    const saved = JSON.parse(raw); const assignment = assignments.find(item => item.id === saved.assignmentId);
    if (saved.schemaVersion !== 1 || saved.submissionId !== match[1] || Object.entries(identity).some(([key, value]) => saved[key] !== value)
      || !/^[a-f0-9]{64}$/.test(saved.scopeRevision) || !Number.isFinite(Date.parse(saved.createdAt))
      || typeof saved.markdown !== "string" || !saved.markdown.trim() || saved.markdown.length > 200_000
      || !assignment || assignment.workflowMode !== "automatic" || assignment.stage !== "plan" || assignment.execution.role !== "planner"
      || assignment.agentId !== saved.plannerAgentId || assignment.execution.model !== saved.plannerModel || assignment.execution.policyRevision !== saved.policyRevision
      || Date.parse(saved.createdAt) < Date.parse(assignment.createdAt)) throw new Error("Automatic plan provenance is invalid.");
    const brief = normalizePlanBrief(saved.brief);
    if (!brief) throw new Error("Automatic plans require a readable brief.");
    history.push({ ...saved, brief, revision: match[2], documentRevision: hash(saved.markdown), path: `automatic-plans/${name}` });
  }
  history.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.submissionId.localeCompare(a.submissionId));
  const saved = history[0];
  if (!saved) return null;
  const current = await currentPlan(task);
  return { ...saved, currentMatch: current?.documentRevision === saved.documentRevision,
    scopeMatch: saved.scopeRevision === planScopeRevision(record, identity), policyMatch: !policyRevision || policyRevision === saved.policyRevision };
}

export async function verifyAutomaticPlanAcceptance(input) {
  const plan = await readAutomaticPlan(input);
  if (!plan || !plan.currentMatch || !plan.scopeMatch || !plan.policyMatch) throw new Error("Submit the current scoped plan before implementation.");
  const { readPipelineCheckpoints } = await import("./pipeline-records.mjs");
  const checkpoints = await readPipelineCheckpoints(input.runFolder, input.identity);
  const assignments = await readStageAssignments(input.runFolder, input.identity);
  const modelKey = value => value.toLowerCase().split("/").at(-1).replace(/[._-]/g, "").replace(/(?:latest|\d{8})$/, "");
  const review = checkpoints.find(item => item.stage === "plan-review" && item.planRevision === plan.revision);
  const assignment = review?.execution && assignments.find(item => item.id === review.execution.assignmentId);
  if (!review || review.verdict !== "pass" || review.scope !== "approved" || !review.planReview || review.planReview.findings.length
    || review.planReview.scopeRevision !== plan.scopeRevision || review.execution?.policyRevision !== plan.policyRevision || review.execution?.role !== "planReviewer"
    || review.agentId === plan.plannerAgentId || modelKey(review.execution.model) === modelKey(plan.plannerModel)
    || review.candidate.head !== null || review.candidate.tree !== plan.revision || review.createdAt < plan.createdAt
    || !assignment || assignment.stage !== "plan-review" || assignment.workflowMode !== "automatic" || assignment.agentId !== review.agentId
    || assignment.planRevision !== plan.revision || assignment.planScopeRevision !== plan.scopeRevision || JSON.stringify(assignment.execution) !== JSON.stringify(review.execution)) throw new Error("The current plan needs a passing independent model critique before implementation.");
  return plan;
}

/** Caller holds the run lock and verifies the actual native planner before saving. */
export async function saveAutomaticPlan({ taskFolder, runFolder, task: record, identity, assignment, brief }) {
  const { task, run } = await folders(taskFolder, runFolder);
  const assignments = await readStageAssignments(run, identity);
  const actual = assignments.find(item => item.id === assignment?.id);
  if (!actual || JSON.stringify(actual) !== JSON.stringify(assignment) || actual.workflowMode !== "automatic" || actual.stage !== "plan" || actual.execution.role !== "planner") throw new Error("An automatic managed planner assignment is required.");
  const current = await currentPlan(task); const normalized = normalizePlanBrief(brief);
  if (!current || !normalized) throw new Error("Write plan.md and supply a readable planBrief before submitting the plan.");
  const previous = await readAutomaticPlan({ taskFolder, runFolder, task: record, identity });
  if (previous && (previous.documentRevision !== current.documentRevision || JSON.stringify(previous.brief) !== JSON.stringify(normalized)) && !normalized.changesSincePrevious.length) throw new Error("Explain changesSincePrevious when revising the plan.");
  const saved = { schemaVersion: 1, submissionId: randomUUID(), ...identity, scopeRevision: planScopeRevision(record, identity),
    assignmentId: actual.id, plannerAgentId: actual.agentId, plannerModel: actual.execution.model, policyRevision: actual.execution.policyRevision,
    createdAt: new Date(Math.max(Date.now(), previous ? Date.parse(previous.createdAt) + 1 : 0)).toISOString(), markdown: current.markdown, brief: normalized, previousRevision: previous?.revision ?? null };
  const raw = JSON.stringify(saved); const revision = hash(raw);
  await mkdir(join(run, "automatic-plans"), { recursive: true });
  const directory = await realpath(join(run, "automatic-plans"));
  if (!inside(run, directory)) throw new Error("Automatic plans escape the run.");
  const name = `${saved.submissionId}.${revision}.json`;
  await writeFile(join(directory, name), raw, { flag: "wx" });
  return { ...saved, revision, documentRevision: current.documentRevision, path: `automatic-plans/${name}`, currentMatch: true, scopeMatch: true, policyMatch: true };
}

export async function verifyPlanApproval(input, expectedPlanRevision) {
  const plan = await readPlanSnapshot(input);
  if (!plan.revision || !expectedPlanRevision || expectedPlanRevision !== plan.revision) throw new Error("Read the saved plan version before approving. Request a fresh proposal for an older decision.");
  if (!plan.currentMatch || !plan.brief) throw new Error(plan.warning || "Plan is not ready for approval.");
  return plan;
}
