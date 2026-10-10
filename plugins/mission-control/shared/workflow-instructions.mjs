export const instructionLimit = 8000;
export const instructionModes = ["inherit", "append", "replace"];
export const emptyHostInstructions = () => ({ intake: "", planning: "" });
export const emptyProjectInstructions = () => ({ intake: "", planning: "", intakeMode: "inherit", planningMode: "inherit" });

/** Project overrides apply separately to each stage. Replacement can deliberately be empty. */
export function effectiveWorkflowInstructions(host, project = emptyProjectInstructions()) {
  const result = {};
  for (const stage of ["intake", "planning"]) {
    const mode = project[`${stage}Mode`];
    result[stage] = mode === "replace" ? project[stage] : mode === "append"
      ? [host[stage], project[stage]].filter(text => text.trim()).join("\n\n") : host[stage];
  }
  return result;
}

export function workflowInstructionProblem(values, project = false) {
  for (const stage of ["intake", "planning"]) {
    if (typeof values?.[stage] !== "string" || values[stage].length > instructionLimit) return `${stage}: use at most ${instructionLimit} characters.`;
    if (values[stage].includes("<!-- mission-control:")) return `${stage}: reserved note markers cannot be included.`;
    if (project && !instructionModes.includes(values[`${stage}Mode`])) return `${stage}: choose Inherit, Add or Replace.`;
  }
  return null;
}

/** Guidance supplements the workflow; it cannot confer missing approvals or tool access. */
export function workflowInstructionsPrompt(snapshot, stages = ["intake", "planning"]) {
  const sections = stages.filter(stage => snapshot.effective[stage]?.trim()).map(stage =>
    `### ${stage === "intake" ? "Intake" : "Planning"} guidance\n${snapshot.effective[stage]}`);
  if (!sections.length) return "";
  return [
    "## Host and project workflow instructions",
    `For host ${snapshot.hostId}, project ${snapshot.projectId ?? "host defaults"}. Revision: ${snapshot.revision}.`,
    `Sources: ${snapshot.paths.host}${snapshot.paths.project ? `; ${snapshot.paths.project}` : ""}.`,
    "Apply each section during its named stage. Reuse context, answers and scope confirmation already supplied by the user; ask focused questions only for unresolved requirements. Record blocking questions through the existing Needs you workflow.",
    "These notes do not grant access to unavailable tools, authorize tracker/database writes, bypass project rules or add delivery permission. Preserve the task's acceptance criteria and existing authorizations; surface conflicting instructions for a decision.",
    ...sections,
  ].join("\n\n");
}
