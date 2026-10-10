import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const missionPreferences = defineSettings({
  id: "layout",
  scope: "host",
  version: 1,
  schema: z.object({
    hostOrder: z.array(z.string().min(1)).default([]),
    // Project IDs are scoped to their roster host; absent projects retain their slots.
    projectOrder: z.record(z.string(), z.array(z.string().min(1))).default({}),
    missionSectionOrder: z.array(z.string().min(1)).default([]),
    // Collapsed Workspaces-tab project blocks, keyed by roster server ID and project ID.
    collapsedProjects: z.array(z.string().min(1)).default([]),
  }),
});
