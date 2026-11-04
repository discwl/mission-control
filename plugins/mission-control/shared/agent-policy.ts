import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

export const workflowRoles = ["planner", "planReviewer", "builder", "validator", "reviewer", "reviewer2"] as const;
export const workflowRoleSchema = z.enum(workflowRoles);
export type WorkflowRole = z.infer<typeof workflowRoleSchema>;
export const nativeProfileSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), provider: z.string().min(1), model: z.string().optional(),
  modeId: z.string().optional(), thinkingOptionId: z.string().optional(),
  featureValues: z.record(z.string(), z.unknown()).optional(), notes: z.string().optional(),
});
export const roleMappingSchema = z.object({
  planner: z.string().min(1), planReviewer: z.string().min(1).nullable().optional(), builder: z.string().min(1), validator: z.string().nullable().default(null),
  reviewer: z.string().min(1), reviewer2: z.string().nullable().default(null), reviewCount: z.union([z.literal(1), z.literal(2)]).default(1),
}).refine(value => value.reviewCount === 1 || Boolean(value.reviewer2 && value.reviewer2 !== value.reviewer), "Two reviews require two different profiles.");
export type RoleMapping = z.infer<typeof roleMappingSchema>;
export const agentPolicySchema = z.object({
  projectId: z.string().nullable(), taskId: z.string().nullable(), mapping: roleMappingSchema, updatedAt: z.string(),
});
export const resolvedProfileSchema = nativeProfileSchema.extend({ model: z.string().min(1), role: workflowRoleSchema });
export type ResolvedProfile = z.infer<typeof resolvedProfileSchema>;
export const resolvedPolicySchema = z.object({
  revision: z.string(), source: z.enum(["host", "project", "task"]), reviewCount: z.union([z.literal(1), z.literal(2)]),
  profiles: z.array(resolvedProfileSchema),
});
export type ResolvedPolicy = z.infer<typeof resolvedPolicySchema>;
export const readAgentPolicy = defineRpc({ name: "workflow.agents.read", input: z.object({ serverId: z.string(), projectId: z.string().nullable().default(null), taskId: z.string().nullable().default(null), workflowMode: z.enum(["manual", "automatic"]).default("manual") }), output: z.object({ revision: z.number(), profiles: z.array(nativeProfileSchema), policies: z.array(agentPolicySchema), effective: resolvedPolicySchema.nullable(), problem: z.string().nullable() }) });
export const saveAgentPolicy = defineRpc({ name: "workflow.agents.save", input: z.object({ serverId: z.string(), projectId: z.string().nullable(), taskId: z.string().nullable(), mapping: roleMappingSchema.nullable(), expectedRevision: z.number().int() }), output: z.object({ revision: z.number() }) });

/** Profile names/provider aliases do not make the same underlying model independent. */
export function modelIdentity(model: string): string {
  return model.toLowerCase().split("/").at(-1)!.replace(/[._-]/g, "").replace(/(?:latest|\d{8})$/, "");
}
export function resolveRolePolicy(policies: z.infer<typeof agentPolicySchema>[], profiles: z.infer<typeof nativeProfileSchema>[], projectId: string | null, taskId: string | null, workflowMode: "manual" | "automatic" = "manual"): ResolvedPolicy | null {
  const selected = policies.find(item => taskId && item.taskId === taskId && item.projectId === projectId)
    ?? policies.find(item => projectId && item.projectId === projectId && item.taskId === null)
    ?? policies.find(item => item.projectId === null && item.taskId === null);
  if (!selected) return null;
  const mapping = selected.mapping;
  const reviewCount = workflowMode === "automatic" ? 2 : mapping.reviewCount;
  const planner = profiles.find(item => item.id === mapping.planner);
  const planReviewer = mapping.planReviewer ?? [mapping.reviewer, mapping.reviewer2].find(id => {
    const candidate = profiles.find(item => item.id === id);
    return candidate?.model && planner?.model && modelIdentity(candidate.model) !== modelIdentity(planner.model);
  });
  const roles = workflowRoles.filter(role => (role !== "reviewer2" || reviewCount === 2) && (role !== "planReviewer" || workflowMode === "automatic"));
  const resolved = roles.map(role => {
    const id = role === "validator" ? mapping.validator ?? mapping.builder : role === "planReviewer" ? planReviewer : mapping[role];
    const profile = profiles.find(item => item.id === id);
    if (!profile) throw new Error(`Choose an available native Paseo profile for ${role}.`);
    if (!profile.model || /^(auto|default)$/i.test(profile.model)) throw new Error(`${profile.name} needs an explicit model. Automatic model selection cannot be verified.`);
    return resolvedProfileSchema.parse({ ...profile, role });
  });
  if (reviewCount === 2 && modelIdentity(resolved.find(item => item.role === "reviewer")!.model) === modelIdentity(resolved.find(item => item.role === "reviewer2")!.model)) throw new Error("Choose two different underlying review models, even when they use different providers.");
  const critic = resolved.find(item => item.role === "planReviewer");
  if (critic && modelIdentity(critic.model) === modelIdentity(resolved.find(item => item.role === "planner")!.model)) throw new Error("Choose a different underlying model for the independent plan check.");
  return { revision: JSON.stringify([selected.updatedAt, resolved]), source: selected.taskId ? "task" : selected.projectId ? "project" : "host", reviewCount, profiles: resolved };
}
