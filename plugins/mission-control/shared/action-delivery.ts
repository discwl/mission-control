import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { actionBundleSchema } from "./action-bundle.mjs";
const ref = z.object({ serverId: z.string(), taskId: z.string().regex(/^task_[a-f0-9-]+$/) });
export const actionDeliveryPlanSchema = z.object({ taskId: z.string(), runId: z.string(), workspaceId: z.string(), title: z.string(), kind: z.enum(["actions", "report"]), revision: z.string(), fingerprint: z.string(), planRevision: z.string(), policyRevision: z.string(), agentId: z.string(), bundle: actionBundleSchema });
export type ActionDeliveryPlan = z.infer<typeof actionDeliveryPlanSchema>;
export const checkActionDelivery = defineRpc({ name: "actions.check", input: ref, output: z.object({ ready: z.boolean(), reason: z.string(), plan: actionDeliveryPlanSchema.nullable(), completed: z.boolean().optional(), authorized: z.boolean().optional() }) });
// Registered only as a human UI/native-chat RPC, never an agent tool.
export const authorizeActionDelivery = defineRpc({ name: "actions.authorize", input: ref.extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), actorId: z.string().min(1) }), output: z.object({ outcome: z.enum(["resumed", "uncertain", "refused"]), reason: z.string(), revision: z.string().nullable() }) });
