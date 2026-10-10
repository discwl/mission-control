import type { FlowDocument, FlowEvent } from "./task-flow-model";

export type EvidenceReference = { kind: "document"; document: FlowDocument } | { kind: "statement" | "unavailable"; text: string };

/** Resolve only in the selected task; never link a different task's file by basename. */
export function resolveEvidence(value: string, documents: readonly FlowDocument[], taskId: string): EvidenceReference {
  const text = value.trim(), path = text.replaceAll("\\", "/");
  const windows = /^[a-z]:\//i.test(path) || path.startsWith("//");
  const absolute = windows || path.startsWith("/"), segments = path.split("/");
  let name = path.replace(/^\.\//, "");
  if (absolute) {
    const marker = segments.findIndex((segment, index) => (windows ? segment.toLowerCase() === taskId.toLowerCase() : segment === taskId) && (windows ? segments[index - 1]?.toLowerCase() === "tasks" : segments[index - 1] === "Tasks"));
    name = marker >= 0 ? segments.slice(marker + 1).join("/") : "";
  }
  if (name && !name.split("/").some(segment => segment === ".." || segment === ".")) {
    const matches = documents.filter(document => windows ? document.name.toLowerCase() === name.toLowerCase() : document.name === name);
    if (matches.length === 1) return { kind: "document", document: matches[0] };
  }
  const fileReference = /\.(?:md|txt|json|yaml|yml|pdf|log)$/i.test(path) && (absolute || !/[\s:]/.test(path));
  return { kind: fileReference ? "unavailable" : "statement", text };
}

export function eventSummary(event: FlowEvent): string {
  return event.body.replace(new RegExp(`^#\\s+${event.stage}\\s*:\\s*${event.outcome}\\s*(?:\\r?\\n|$)`, "i"), "").trim();
}

export function activityTitle(event: Pick<FlowEvent, "stage" | "outcome">): string {
  const stages: Record<FlowEvent["stage"], string> = { intake: "Intake", plan: "Planning", execute: "Implementation", validate: "Validation", review: "Review", fix: "Fixes", delivery: "Delivery", handoff: "Handoff" };
  const outcomes: Record<FlowEvent["outcome"], string> = { completed: "completed", in_progress: "in progress", blocked: "blocked", waiting: "waiting" };
  return `${stages[event.stage]} ${outcomes[event.outcome]}`;
}

/** Hide only the generated evidence list already represented by structured evidence. */
export function activityBody(event: FlowEvent): string {
  return eventSummary(event).replace(/(^|\n)#{1,6}\s+Evidence\s*\r?\n([\s\S]*?)(?=\n#{1,6}\s|$)/gi, (section, prefix: string, body: string) => {
    const lines = body.trim().split(/\r?\n/).filter((line: string) => line.trim());
    const values = lines.map((line: string) => /^\s*[-*+]\s+(.+)$/.exec(line)?.[1].trim());
    return values.length > 0 && values.length === event.evidence.length && values.every((value: string | undefined, index: number) => value === event.evidence[index]) ? prefix : section;
  }).trim();
}

export function artifactLabel(document: FlowDocument, events: readonly FlowEvent[] = []): string {
  const event = events.find(candidate => candidate.source === document.name);
  if (event) return `${event.stage[0].toUpperCase()}${event.stage.slice(1)} update`;
  if (document.name.includes("/events/")) return "Activity record";
  if (document.name.startsWith("runs/")) return document.name.endsWith("/handoff.md") ? "Run handoff" : "Run summary";
  const titles: Record<string, string> = { "task.md": "Task brief", "plan.md": "Implementation plan", "report.md": "Report", "review.md": "Review report", "status.md": "Status", "notes.md": "Notes" };
  return titles[document.name] ?? document.name.replace(/\.md$/i, "").replaceAll("-", " ").replaceAll("_", " ");
}

export function artifactPreview(document: FlowDocument): string {
  return document.content.replace(/^# Run run_[a-f0-9-]+\s*$/m, "# Run summary");
}
