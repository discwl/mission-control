import type { PlanBrief } from "./plan-approval";
import type { DecisionEntry } from "./decisions";
import type { PullRequestPlan } from "./pull-request";

const bullets = (values: readonly string[]) => values.map(text => `• ${text}`).join("\n");
export function chatPlan(title: string, host: string, brief: PlanBrief, revision: string) {
  return `${host} · ${title}\nPlan for your approval · ${revision.slice(0, 12)}\n\nGoal: ${brief.goal}\nToday: ${brief.before}\nAfter this work: ${brief.after}\n\nIncluded\n${bullets(brief.included)}\n\nDeferred\n${bullets(brief.deferred)}\n\nAffected\n${bullets(brief.affected)}\n\nApproach\n${bullets(brief.approach)}\n\nHow we will check it\n${bullets(brief.successChecks)}\n\nRisks\n${bullets(brief.risks)}\n\nScope change: ${brief.scopeChange}\nAuthorization: ${brief.authorization}${brief.changesSincePrevious.length ? `\n\nChanges since the previous plan\n${bullets(brief.changesSincePrevious)}` : ""}\n\nApproval permits only this plan's implementation. Publishing, PRs, merges, deployments and tracker updates require separate authorization.`;
}
export function chatReview(entry: DecisionEntry, host: string) {
  const decision = entry.decision;
  return `${host} · ${entry.taskTitle}\nCode review for your approval\n\n${entry.summary}\n\n${decision.question}\n\nReviewed HEAD: ${decision.candidate?.head ?? decision.gitHead ?? "unavailable"}\nReviewed tree: ${decision.candidate?.tree ?? "unavailable"}\n${entry.unverifiedFindings} previous findings still need verification.\n\nFindings\n${entry.findings.length ? entry.findings.map(f => `${f.severity.toUpperCase()} · ${f.plain?.description ?? f.title}\n${f.plain?.impact ?? f.detail}\nStatus: ${f.status}${f.file ? ` · ${f.file}` : ""}\nFinding: ${f.findingId}`).join("\n\n") : "No findings in this request."}\n\nEvidence\n${bullets(decision.evidence)}\n\nRequesting changes sends the open findings and your note back to the worker. Accepting this review does not authorize a commit, push, PR, merge, deployment or tracker update.`;
}
export function chatPullRequest(plan: PullRequestPlan, host: string) {
  return `${host} · ${plan.taskTitle}\nDraft PR preview\n\nRepository: ${plan.repository}\nRemote: ${plan.remote}\nBranch: ${plan.taskBranch} → ${plan.targetBranch}\nReviewed candidate fingerprint: ${plan.fingerprint}\n\n1. Commit ${plan.uncommittedCount} changed files with:\n${plan.commitMessage}\n${bullets(plan.uncommittedFiles)}${plan.uncommittedCount > plan.uncommittedFiles.length ? `\n…and ${plan.uncommittedCount - plan.uncommittedFiles.length} more files. Open Review to inspect the complete change.` : ""}\n2. Push only ${plan.taskBranch}, without force.\n3. Create a draft PR; do not merge it.\n\nTitle: ${plan.title}\n\n${plan.body}\n\nThe task is recorded as In review. Tracker comments, merges and deployments are not included.`;
}
export function chatLinks(serverId: string, workspaceId: string, agentId?: string | null) {
  const base = `https://app.paseo.sh/h/${encodeURIComponent(serverId)}`;
  return `${agentId ? `Chat: ${base}/agent/${encodeURIComponent(agentId)}\n` : ""}Workspace: ${base}/workspace/${encodeURIComponent(workspaceId)}`;
}
