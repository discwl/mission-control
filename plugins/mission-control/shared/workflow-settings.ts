import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { instructionLimit } from "./workflow-instructions.mjs";
const text = z.string().max(instructionLimit);
export const hostInstructionsSchema = z.object({ intake: text, planning: text });
export const projectInstructionsSchema = hostInstructionsSchema.extend({ intakeMode: z.enum(["inherit", "append", "replace"]), planningMode: z.enum(["inherit", "append", "replace"]) });
const identity = z.object({ serverId: z.string().min(1), projectId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/).nullable() });
export const workflowInstructionsSchema = identity.extend({
  hostId: z.string(), host: hostInstructionsSchema, project: projectInstructionsSchema,
  effective: z.object({ intake: z.string(), planning: z.string() }), revision: z.string(),
  paths: z.object({ host: z.string(), project: z.string().nullable() }),
});
export const getWorkflowInstructions = defineRpc({ name: "get-workflow-instructions", input: identity, output: workflowInstructionsSchema });
export const saveWorkflowInstructions = defineRpc({ name: "save-workflow-instructions", input: identity.extend({ expectedRevision: z.string().min(1), values: z.union([projectInstructionsSchema, hostInstructionsSchema]) }), output: workflowInstructionsSchema });
