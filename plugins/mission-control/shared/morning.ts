import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { taskSchema } from "./tasks";
import { trackerItemSchema } from "./tickets";

// Written by scripts/morning-check.mjs to Daily/<reportId>.md; the format is in docs/agent-workflow.md.
export const morningReportIdSchema = z.string().regex(/^morning-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?$/);
const count = z.number().int().nonnegative();
export const morningReportSchema = z.object({
  schemaVersion: z.literal(1),
  reportId: morningReportIdSchema,
  hostId: z.string().min(1),
  serverId: z.string().min(1),
  agentId: z.string().nullable(),
  createdAt: z.string().min(1),
  since: z.string().min(1),
  tracker: z.object({ mode: z.enum(["read", "unavailable", "fixture"]), systems: z.array(trackerItemSchema.shape.system) }),
  items: z.array(trackerItemSchema.extend({ taskIds: z.array(z.string()) })).max(200),
  review: z.object({ missing: count, imported: count, handoffs: count, openDecisions: count, blocked: count, idle: count, unreadable: count }),
});
export type MorningReport = z.infer<typeof morningReportSchema>;

// A Morning check start is a receipt that an agent got the prompt, not a finished report.
export const morningLaunchSchema = z.object({
  launchId: z.string().uuid(),
  agentId: z.string().min(1),
  serverId: z.string().min(1),
  workspaceId: z.string().min(1),
  provider: z.string().min(1),
  fixture: z.boolean(),
  phase: z.enum(["sending", "sent"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  error: z.string().nullable(),
});
export type MorningLaunch = z.infer<typeof morningLaunchSchema>;

const reportItemSchema = morningReportSchema.shape.items.element;
// "invalid": a task file that is skipped because it is invalid, but whose ticket shows it was imported.
const taskBriefSchema = taskSchema.pick({ taskId: true, title: true }).extend({ status: taskSchema.shape.status.or(z.literal("invalid")) });
export type MorningTaskBrief = z.infer<typeof taskBriefSchema>;
export const morningStatusSchema = z.object({
  report: morningReportSchema.extend({ file: z.string(), body: z.string() }).nullable(),
  reportError: z.string().nullable(),
  // Compared with the host's tasks now, so items imported after the report was written show as imported.
  missing: z.array(reportItemSchema),
  imported: z.array(z.object({ item: reportItemSchema, tasks: z.array(taskBriefSchema) })),
  launch: morningLaunchSchema.nullable(),
  agent: z.object({ id: z.string(), title: z.string(), status: z.string(), busy: z.boolean() }).nullable(),
});
export type MorningStatus = z.infer<typeof morningStatusSchema>;

const hostInput = z.object({ serverId: z.string().min(1) });
export const getMorningStatus = defineRpc({ name: "morning.status", input: hostInput, output: morningStatusSchema });
export const startMorningCheck = defineRpc({
  name: "morning.start",
  input: hostInput.extend({
    workspaceId: z.string().min(1),
    provider: z.string().min(3).max(300).regex(/\//),
    modeId: z.string().min(1).max(100).optional(),
    thinkingOptionId: z.string().min(1).max(100).optional(),
    fixture: z.boolean(),
  }),
  output: morningStatusSchema,
});
export const importMorningItems = defineRpc({
  name: "morning.import",
  input: hostInput.extend({
    workspaceId: z.string().min(1),
    reportId: morningReportIdSchema,
    // Ticket identities from ticketIdentity(): "<system>:<KEY>".
    items: z.array(z.string().min(1).max(200)).min(1).max(200),
  }),
  output: z.object({
    created: z.array(taskBriefSchema.extend({ key: z.string() })),
    skipped: z.array(z.object({ key: z.string(), taskIds: z.array(z.string()) })),
  }),
});
