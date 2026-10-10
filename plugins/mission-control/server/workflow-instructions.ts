import type { PluginServerContext } from "@getpaseo/plugin/server";
import { defaultVaultPath } from "../shared/vault";
import { getWorkflowInstructions, saveWorkflowInstructions } from "../shared/workflow-settings";
import { createWorkflowInstructionsStore } from "./workflow-instructions-store.mjs";

export function registerWorkflowInstructions(server: PluginServerContext) {
  const store = createWorkflowInstructionsStore(defaultVaultPath);
  server.handle(getWorkflowInstructions, async (input, { paseo }) => {
    if (input.projectId !== null && !(await paseo.projects.list()).projects.some(project => project.projectId === input.projectId)) throw new Error("This project is unavailable on the selected host.");
    return store.read(input);
  });
  server.handle(saveWorkflowInstructions, async (input, { paseo }) => {
    if (input.projectId !== null && !(await paseo.projects.list()).projects.some(project => project.projectId === input.projectId)) throw new Error("This project is unavailable on the selected host.");
    return store.save(input);
  });
}
