import type { HostInstructions, ProjectInstructions, WorkflowInstructions } from "../shared/workflow-instructions.mjs";
export type WorkflowIdentity = { serverId: string; hostId?: string; projectId: string | null };
export function createWorkflowInstructionsStore(vaultRoot: string): {
  read(input: WorkflowIdentity): Promise<WorkflowInstructions>;
  save(input: WorkflowIdentity & { expectedRevision: string; values: HostInstructions | ProjectInstructions }): Promise<WorkflowInstructions>;
};
