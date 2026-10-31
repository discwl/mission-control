import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { createTask } from "./tasks";
import { getMorningStatus, startMorningCheck, importMorningItems } from "./morning";
const coordinator = { coordinatorId: z.string().min(1) };
export const intakeDiscoveryStatus = defineRpc({ name: "intake.discovery.status", input: getMorningStatus.input.extend(coordinator), output: getMorningStatus.output });
export const intakeDiscoveryStart = defineRpc({ name: "intake.discovery.start", input: startMorningCheck.input.extend(coordinator), output: startMorningCheck.output });
export const intakeDiscoveryImport = defineRpc({ name: "intake.discovery.import", input: importMorningItems.input.extend(coordinator), output: importMorningItems.output });

export const intakeAction = z.enum(["backlog", "queue", "plan"]);
export type IntakeAction = z.infer<typeof intakeAction>;
const destination = z.object({ coordinatorId: z.string().min(1), remoteServerId: z.string().min(1) });
export const intakeReceipt = z.object({ taskId: z.string(), title: z.string(), action: intakeAction, completed: z.boolean(), message: z.string() });
export const captureIntake = defineRpc({ name: "intake.capture", input: destination.extend({
  workspaceId: z.string().min(1), requestId: z.string().uuid(), title: createTask.input.shape.title,
  acceptanceCriteria: createTask.input.shape.acceptanceCriteria, action: intakeAction,
}), output: intakeReceipt });
export const routeIntake = defineRpc({ name: "intake.route", input: destination.extend({ taskId: z.string().regex(/^task_[a-f0-9-]+$/), action: intakeAction }), output: intakeReceipt });
