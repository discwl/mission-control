import type { RpcInput } from "@getpaseo/plugin";
import type { PaseoApi } from "@getpaseo/client";
import { resolveChatReview } from "../shared/chat-review";
import type { createDecisionStore } from "./decisions";
import { daemonServerId } from "./agent-names";
import { reviewCandidate } from "./merge";

export async function resolveCurrentChatReview(input: RpcInput<typeof resolveChatReview>, paseo: PaseoApi, decisions: ReturnType<typeof createDecisionStore>) {
  if (input.serverId !== await daemonServerId()) throw new Error("This review belongs to another host.");
  if (input.outcome !== "approved") throw new Error("This endpoint only accepts a current review approval.");
  const entry = (await decisions.list(input.serverId)).open.find(entry => entry.decision.decisionId === input.decisionId && entry.decision.taskId === input.taskId && entry.decision.runId === input.runId && entry.decision.workspaceId === input.workspaceId);
  if (!entry || entry.decision.kind !== "review" || entry.revision !== input.expectedRevision) throw new Error("The review request changed. Read the current review again.");
  const expected = input.expectedCandidate;
  if (!entry.decision.candidate || expected.head !== entry.decision.candidate.head || expected.tree !== entry.decision.candidate.tree) throw new Error("The reviewed revision cannot be verified. Request a fresh code review.");
  const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
  if (!workspace?.workspaceDirectory || workspace.archivingAt) throw new Error("The reviewed workspace is unavailable.");
  const actual = await reviewCandidate(workspace.workspaceDirectory);
  if (actual.head !== expected.head || actual.tree !== expected.tree) throw new Error("The code changed after this review. Request a fresh review before accepting it.");
  // The original service rechecks the decision revision under its run lock and owns resume.
  return decisions.resolve(input, paseo);
}
