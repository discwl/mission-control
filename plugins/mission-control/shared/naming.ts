// Shared naming policy: docs/agent-workflow.md#naming-checkpoints.

export function nameWarnings(name: string, workspaceName?: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return ["Enter a name."];
  const warnings: string[] = [];
  // Workspace ticket prefixes are identifiers, not part of the descriptive 2–5 words.
  const description = workspaceName === undefined ? trimmed.replace(/^(?:[A-Z][A-Z0-9_]*-\d+|\d+)(?:,\s*(?:[A-Z][A-Z0-9_]*-\d+|\d+))*\s*·\s*/i, "") : trimmed;
  const words = description.split(/\s+/).length;
  if (words > 5) warnings.push(`Aim for 2–5 words (this has ${words}).`);
  if (workspaceName && trimmed.toLowerCase().startsWith(workspaceName.trim().toLowerCase())) {
    warnings.push("Drop the workspace name; the tab already shows it.");
  }
  return warnings;
}

/** A rename or undo applies only if nobody renamed the item after it was reviewed. */
export function renameConflict(expected: string, current: string): string | null {
  return expected === current ? null : `Renamed to “${current}” since you opened this. Review it again before applying.`;
}
