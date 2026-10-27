import { z } from "zod";
import type { DecisionEntry } from "../shared/decisions";
import { initialChoices, type Answer, type ButtonId, type Choices, type NoteState } from "./decision-card-model";
import { pageMemory, pageKey } from "./page-memory";
import { usePageState } from "./page-state";
import { readClientStorage, writeClientStorage } from "./web";

type Confirmation = Answer & { id: ButtonId; planRevision?: string; requestRevision: string };
export type DecisionDraft = { version: 1; identity: string; requestRevision: string; note: NoteState; choices: Choices; confirm: Confirmation | null; updatedAt: string | null; durable: boolean };
const draftSchema = z.object({
  version: z.literal(1), identity: z.string(), requestRevision: z.string(),
  note: z.object({ text: z.string().max(8000), edited: z.boolean() }), choices: z.record(z.string(), z.enum(["fix", "skip"])),
  confirm: z.object({ outcome: z.enum(["approved", "changes_requested", "blocked"]), note: z.string().max(8000), confirm: z.boolean(), prompt: z.string(), sendLabel: z.string(), noteRequired: z.boolean(), id: z.enum(["accept", "fix", "change", "stop"]), planRevision: z.string().optional(), requestRevision: z.string() }).nullable(),
  updatedAt: z.string().nullable(), durable: z.boolean(),
});
export const decisionDraftKey = (entry: DecisionEntry, serverId: string) => pageKey("mission-control", "decision-draft", serverId, entry.decision.workspaceId, entry.decision.taskId, entry.decision.runId, entry.decision.decisionId);
export function restoreDecisionDraft(value: unknown, identity: string): DecisionDraft | null {
  const parsed = draftSchema.safeParse(value);
  return parsed.success && parsed.data.identity === identity ? parsed.data : null;
}
export function useDecisionDraft(entry: DecisionEntry, serverId: string) {
  const key = decisionDraftKey(entry, serverId);
  const empty = (): DecisionDraft => ({ version: 1, identity: key, requestRevision: entry.revision, note: { text: "", edited: false }, choices: initialChoices(entry.findings), confirm: null, updatedAt: null, durable: false });
  const [draft] = usePageState<DecisionDraft>(key, () => {
    try { return restoreDecisionDraft(JSON.parse(readClientStorage(key) ?? "null"), key) ?? empty(); } catch { return empty(); }
  });
  const hasContent = (value: DecisionDraft) => value.note.edited || value.confirm !== null || JSON.stringify(value.choices) !== JSON.stringify(initialChoices(entry.findings));
  function clear() { writeClientStorage(key, null); pageMemory.write(key, empty()); }
  function update(patch: Partial<DecisionDraft>) {
    const current = pageMemory.read(key, empty);
    const next = { ...current, ...patch, requestRevision: current.updatedAt ? current.requestRevision : entry.revision, updatedAt: new Date().toISOString() };
    if (!hasContent(next)) { clear(); return; }
    next.durable = writeClientStorage(key, JSON.stringify({ ...next, durable: true }));
    pageMemory.write(key, next);
  }
  function setChoices(value: Choices | ((previous: Choices) => Choices)) { update({ choices: typeof value === "function" ? value(pageMemory.read(key, empty).choices) : value }); }
  function useForCurrentRequest() {
    const current = pageMemory.read(key, empty);
    update({ requestRevision: entry.revision, confirm: null, choices: initialChoices(entry.findings), note: current.confirm ? { text: current.confirm.note, edited: true } : current.note });
    // update deliberately retains an old revision during normal edits; rebinding is explicit here.
    const rebound = { ...pageMemory.read(key, empty), requestRevision: entry.revision };
    rebound.durable = writeClientStorage(key, JSON.stringify({ ...rebound, durable: true }));
    pageMemory.write(key, rebound);
  }
  return { draft, saved: draft.updatedAt !== null, stale: draft.updatedAt !== null && draft.requestRevision !== entry.revision,
    setNote: (note: NoteState) => update({ note }), setConfirm: (confirm: Confirmation | null) => update({ confirm }), setChoices, clear, useForCurrentRequest };
}
