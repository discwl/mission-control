import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { pipelineSchema } from "./pipeline-state";
export const launchPipelineStage = defineRpc({ name: "pipeline.stage.launch", input: z.object({
  serverId: z.string(), workspaceId: z.string(), row: pipelineSchema, fingerprint: z.string(), requestId: z.string(),
  parent: z.object({ serverId: z.string(), agentId: z.string() }),
}), output: z.object({ agentId: z.string(), runId: z.string() }) });
