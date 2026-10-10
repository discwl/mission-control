import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Per-workspace counts for the Mission header button. Installation-host workspaces only.
export const getMissionSummary = defineRpc({
  name: "mission.summary",
  input: z.object({ workspaceIds: z.array(z.string().min(1)).max(100) }),
  output: z.object({
    serverId: z.string(),
    summaries: z.record(z.string(), z.object({ openDecisions: z.number().int(), activeTasks: z.number().int() })),
  }),
});
