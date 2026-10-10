export type WorkflowStage = "intake" | "planning";
export type InstructionMode = "inherit" | "append" | "replace";
export type HostInstructions = { intake: string; planning: string };
export type ProjectInstructions = HostInstructions & { intakeMode: InstructionMode; planningMode: InstructionMode };
export type WorkflowInstructions = {
  hostId: string; serverId: string; projectId: string | null;
  host: HostInstructions; project: ProjectInstructions; effective: HostInstructions;
  revision: string; paths: { host: string; project: string | null };
};
export const instructionLimit: number;
export const instructionModes: InstructionMode[];
export function emptyHostInstructions(): HostInstructions;
export function emptyProjectInstructions(): ProjectInstructions;
export function effectiveWorkflowInstructions(host: HostInstructions, project?: ProjectInstructions): HostInstructions;
export function workflowInstructionProblem(values: unknown, project?: boolean): string | null;
export function workflowInstructionsPrompt(snapshot: WorkflowInstructions, stages?: WorkflowStage[]): string;
