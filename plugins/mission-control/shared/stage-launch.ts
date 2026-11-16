import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { pipelineSchema } from "./pipeline-state";

/**
 * The steps of a managed stage start on its host, in order. Each step is recorded before its effect: from "agent" on,
 * a worker may exist; "sending" means its instructions may have been delivered; "sent" means they were.
 */
export const launchStepSchema = z.enum(["accepted", "agent", "run", "assignment", "sending", "sent"]);
export type LaunchStep = z.infer<typeof launchStepSchema>;
export const launchReceiptSchema = z.object({
  requestId: z.string(), phase: z.enum(["running", "done", "failed", "cancelled"]), step: launchStepSchema,
  agentId: z.string().nullable(), runId: z.string().nullable(), error: z.string().nullable(), startedAt: z.string(), updatedAt: z.string(),
});
export type LaunchReceipt = z.infer<typeof launchReceiptSchema>;
/** True once a start did something on its host: from "agent" on, a worker may exist or have its instructions. */
export const launchHadEffects = (receipt: Pick<LaunchReceipt, "step">) => receipt.step !== "accepted";
/** Hosts keep receipts this long; older ones are pruned. */
export const RECEIPT_KEEP_MS = 30 * 24 * 60 * 60_000;
/**
 * Whether a cancelled receipt really means the start never reached its host. A cancellation written long after the
 * attempt may stand in for a receipt that was pruned, which settles nothing.
 */
export const cancelledBeforeArrival = (receipt: Pick<LaunchReceipt, "phase" | "startedAt">, attemptedAt: string) =>
  receipt.phase === "cancelled" && Date.parse(receipt.startedAt) - Date.parse(attemptedAt) < RECEIPT_KEEP_MS;

export const launchPipelineStage = defineRpc({ name: "pipeline.stage.launch", input: z.object({
  serverId: z.string(), workspaceId: z.string(), row: pipelineSchema, fingerprint: z.string(), requestId: z.string(),
  parent: z.object({ serverId: z.string(), agentId: z.string() }),
  // Callers that follow receipts get an answer within about 20 seconds: the worker, or the start's receipt so far.
  // Older callers omit it and wait for the whole start, as before.
  acceptPending: z.boolean().optional(),
}), output: z.union([z.object({ agentId: z.string(), runId: z.string() }), z.object({ receipt: launchReceiptSchema })]) });

/**
 * A stage start's receipt on its host. With cancelIfMissing, a request ID that never reached the host is cancelled for
 * good, so the reply always says what happened and a late request can never start afterwards.
 */
export const launchStageStatus = defineRpc({ name: "pipeline.stage.launch-status",
  input: z.object({ serverId: z.string(), requestId: z.string(), cancelIfMissing: z.boolean().optional() }),
  output: z.object({ receipt: launchReceiptSchema.nullable() }) });
