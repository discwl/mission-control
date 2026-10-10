export type FlowDocument = { name: string; content: string; revision: string; updatedAt: string; editable: boolean };
export const flowStages = ["intake", "plan", "execute", "validate", "review", "fix", "delivery", "handoff"] as const;
export const flowOutcomes = ["in_progress", "completed", "blocked", "waiting"] as const;
export type FlowEvent = { eventId: string; runId: string; taskId: string; stage: typeof flowStages[number]; outcome: typeof flowOutcomes[number]; at: string; agentId: string | null; evidence: string[]; source: string; body: string };
export type FlowIssue = { source: string; reason: string };
const id = (kind: string, value: unknown) => typeof value === "string" && new RegExp(`^${kind}_[a-f0-9-]+$`).test(value);
const date = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) && Number.isFinite(Date.parse(value)) && (() => { const [year, month, day] = value.slice(0, 10).split("-").map(Number); return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate(); })();
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
export function recentActivity(documents: readonly FlowDocument[], taskId: string): { events: FlowEvent[]; issues: FlowIssue[] } {
  const events: FlowEvent[] = [], issues: FlowIssue[] = [];
  const candidates: FlowEvent[] = [];
  for (const document of documents) {
    if (!document.name.includes("/events/")) continue;
    try {
      const path = /^runs\/(run_[a-f0-9-]+)\/events\/(event_[a-f0-9-]+)\.md$/.exec(document.name);
      if (!path) throw new Error("Invalid event document path");
      const lines = document.content.replace(/\r\n/g, "\n").split("\n");
      if (lines[0] !== "---") throw new Error("Event metadata is unavailable");
      const end = lines.indexOf("---", 1);
      if (end < 0) throw new Error("Unterminated event metadata");
      const fields: Record<string, unknown> = Object.create(null);
      for (const line of lines.slice(1, end)) {
        const match = /^([a-zA-Z][a-zA-Z0-9]*): (.+)$/.exec(line);
        if (!match || Object.hasOwn(fields, match[1])) throw new Error("Malformed or duplicate metadata key");
        fields[match[1]] = JSON.parse(match[2]);
      }
      if (fields.schemaVersion !== 1 || !id("task", taskId) || fields.taskId !== taskId || fields.runId !== path[1] || fields.eventId !== path[2]) throw new Error("Event identity does not match the selected task and document path");
      if (!flowStages.includes(fields.stage as typeof flowStages[number]) || !flowOutcomes.includes(fields.outcome as typeof flowOutcomes[number]) || !date(fields.at)) throw new Error("Invalid event stage, outcome or timestamp");
      if (!strings(fields.evidence) || fields.evidence.some(value => !value.trim())) throw new Error("Invalid evidence list");
      if (!(fields.agentId === null || typeof fields.agentId === "string") || !(fields.gitHead === null || typeof fields.gitHead === "string") || typeof fields.gitDirty !== "boolean" || !strings(fields.gitChanges) || !Number.isInteger(fields.omittedChanges) || (fields.omittedChanges as number) < 0) throw new Error("Invalid event agent or Git metadata");
      candidates.push({ eventId: fields.eventId as string, runId: fields.runId as string, taskId, stage: fields.stage as FlowEvent["stage"], outcome: fields.outcome as FlowEvent["outcome"], at: fields.at as string, agentId: fields.agentId as string | null, evidence: fields.evidence, source: document.name, body: lines.slice(end + 1).join("\n").trim() });
    } catch (error) { issues.push({ source: document.name, reason: error instanceof Error ? error.message : String(error) }); }
  }
  const counts = new Map<string, number>();
  candidates.forEach(event => counts.set(event.eventId, (counts.get(event.eventId) ?? 0) + 1));
  for (const event of candidates) {
    if (counts.get(event.eventId)! > 1) issues.push({ source: event.source, reason: "Duplicate event identity; record is ambiguous" });
    else events.push(event);
  }
  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.eventId.localeCompare(b.eventId));
  return { events, issues };
}
export function missingRunIssues(events: readonly FlowEvent[], runs: readonly { runId: string }[] | undefined): FlowIssue[] {
  if (runs === undefined) return [];
  const known = new Set(runs.map(run => run.runId));
  return events.filter(event => !known.has(event.runId)).map(event => ({
    source: event.source,
    reason: "The run for this update is not included in the returned records. This update remains available; its run snapshot is unverified.",
  }));
}
export const recordedOutcome = (outcome: FlowEvent["outcome"]) => ({ in_progress: "Recorded in progress", completed: "Recorded complete", blocked: "Recorded blocked", waiting: "Recorded waiting" })[outcome];
