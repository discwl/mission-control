import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { taskSchema } from "./tasks";
import { runSchema } from "./runs";
import { decisionEntrySchema } from "./decisions";
import { questionEntrySchema } from "./questions";
import { orchestratorWorkSchema } from "./orchestrator-work";

export const fleetScreenId = "orchestrator";
export const fleetAgentSchema = z.object({
  id: z.string(), name: z.string(), workspaceId: z.string().nullable(),
  status: z.string(), archivedAt: z.string().nullable(), labels: z.record(z.string(), z.string()),
  updatedAt: z.string(), activityAt: z.string().nullable(), pendingPermissions: z.number().int().nonnegative(),
  attention: z.boolean(), attentionReason: z.string().nullable(), error: z.string().nullable(),
  inputTokens: z.number().nonnegative().nullable(), outputTokens: z.number().nonnegative().nullable(),
});
export type FleetAgent = z.infer<typeof fleetAgentSchema>;
export const fleetTaskSchema = z.object({
  task: taskSchema, run: runSchema.nullable(), decisions: z.array(decisionEntrySchema),
  questions: z.array(questionEntrySchema), problem: z.string().nullable(),
});
export type FleetTask = z.infer<typeof fleetTaskSchema>;
export const fleetHostSchema = z.object({
  serverId: z.string(), observedAt: z.string(), agents: z.array(fleetAgentSchema),
  workspaces: z.array(z.object({ id: z.string(), name: z.string(), projectName: z.string(), branch: z.string().nullable(), labels: z.array(z.string()).default([]), status: z.string().default("unknown") })),
  tasks: z.array(fleetTaskSchema), warnings: z.array(z.string()), complete: z.boolean(),
  stoppedAgentIds: z.array(z.string()),
});
export type FleetHost = z.infer<typeof fleetHostSchema>;
export const coordinatorSchema = z.object({
  agentId: z.string(), workspaceId: z.string(), name: z.string(),
  remoteServerId: z.string(), hostLabel: z.string(), agent: fleetAgentSchema,
  links: z.array(orchestratorWorkSchema),
});
export type FleetCoordinator = z.infer<typeof coordinatorSchema>;
export const supervisorEntrySchema = z.object({
  agentId: z.string(), remoteServerId: z.string(), enabled: z.boolean().default(false),
  intervalMinutes: z.number().int().min(5).max(120).default(5),
  maxWakeupsPerDay: z.number().int().min(1).max(96).default(24),
  nextCheckAt: z.string().nullable().default(null), lastCheckedAt: z.string().nullable().default(null),
  lastSentAt: z.string().nullable().default(null), message: z.string().default("Not enrolled"),
  date: z.string().default(""), wakeups: z.number().int().nonnegative().default(0),
  lastFingerprint: z.string().nullable().default(null), unchangedAttempts: z.number().int().nonnegative().default(0),
  pending: z.object({ requestId: z.string(), taskId: z.string(), fingerprint: z.string(), attemptedAt: z.string() }).nullable().default(null),
});
export type SupervisorEntry = z.infer<typeof supervisorEntrySchema>;
export const fleetQueueSchema = z.object({
  coordinatorId: z.string(), remoteServerId: z.string(), taskId: z.string(),
  enabled: z.boolean(), priority: z.number().int().min(0).max(9).default(5), updatedAt: z.string(),
});
export type FleetQueueEntry = z.infer<typeof fleetQueueSchema>;
export const fleetEventSchema = z.object({
  id: z.string(), at: z.string(), coordinatorId: z.string().nullable(), remoteServerId: z.string().nullable(),
  taskId: z.string().nullable(), kind: z.enum(["progress", "dispatch", "blocked", "settings", "recovery"]), message: z.string(),
});
export type FleetEvent = z.infer<typeof fleetEventSchema>;
import { pipelineSchema } from "./pipeline-state";
export const fleetStateSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), paused: z.boolean(),
  coordinators: z.array(supervisorEntrySchema), queue: z.array(fleetQueueSchema), events: z.array(fleetEventSchema),
  stoppedAgentIds: z.array(z.string()), seen: z.record(z.string(), z.string()), pipelines: z.array(pipelineSchema).default([]),
});
export type FleetState = z.infer<typeof fleetStateSchema>;
export const fleetSnapshotSchema = z.object({
  serverId: z.string(), observedAt: z.string(), coordinators: z.array(coordinatorSchema),
  hosts: z.array(z.object({ serverId: z.string(), label: z.string(), snapshot: fleetHostSchema.nullable(), error: z.string().nullable() })),
  state: fleetStateSchema, warnings: z.array(z.string()),
  heartbeat: z.object({ checkedAt: z.string().nullable(), error: z.string().nullable() }).default({ checkedAt: null, error: null }),
});
export type FleetSnapshot = z.infer<typeof fleetSnapshotSchema>;
// This RPC executes beside the target host's vault, never on a substituted host.
export const readFleetHost = defineRpc({ name: "orchestrator.host.snapshot", input: z.object({ serverId: z.string() }), output: fleetHostSchema });
export const readFleet = defineRpc({ name: "orchestrator.fleet.read", input: z.object({ refresh: z.boolean().optional() }), output: fleetSnapshotSchema });
export const configureSupervisor = defineRpc({
  name: "orchestrator.supervisor.configure",
  input: z.object({ agentId: z.string(), remoteServerId: z.string(), enabled: z.boolean(), intervalMinutes: z.number().int().min(5).max(120), maxWakeupsPerDay: z.number().int().min(1).max(96), expectedRevision: z.number().int() }),
  output: fleetStateSchema,
});
export const setFleetQueue = defineRpc({
  name: "orchestrator.queue.set",
  input: fleetQueueSchema.omit({ updatedAt: true }).extend({ expectedRevision: z.number().int() }), output: fleetStateSchema,
});
export const pauseFleet = defineRpc({ name: "orchestrator.supervisor.pause", input: z.object({ paused: z.boolean(), expectedRevision: z.number().int() }), output: fleetStateSchema });
export const reconcileFleet = defineRpc({ name: "orchestrator.supervisor.check", input: z.object({}), output: fleetStateSchema });
export const acknowledgeFleetDispatch = defineRpc({
  name: "orchestrator.supervisor.reconcile", input: z.object({ agentId: z.string(), requestId: z.string(), expectedRevision: z.number().int() }), output: fleetStateSchema,
});
