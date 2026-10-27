import { useEffect, useRef, useState } from "react";
import type { PluginTab } from "@getpaseo/plugin/client";
import { z } from "zod";
import { commentAnchorSchema, type ReviewSnapshot } from "../shared/review";

// Keep reviewed code only in this client session, never in browser storage.
const pinnedSnapshots = new Map<string, ReviewSnapshot>();
import { readClientStorage, writeClientStorage } from "./web";

export const reviewSessionSchema = z.object({
  version: z.literal(1), identity: z.string(),
  selectedPath: z.string().nullable(), filter: z.enum(["all", "high", "medium", "low", "info"]),
  mode: z.enum(["blocks", "full"]), layout: z.enum(["split", "unified"]),
  pane: z.enum(["files", "comments"]), fileView: z.enum(["list", "tree"]),
  blockIndex: z.number().int().nonnegative(), showDetail: z.boolean(), showReviewed: z.boolean(),
  showResolved: z.boolean(), showPreview: z.boolean(), agentChoice: z.string().nullable(),
  draft: z.object({ path: z.string(), anchor: commentAnchorSchema.nullable(), commentId: z.string().optional(), initial: z.string().optional(), body: z.string().optional(), fingerprint: z.string().optional() }).nullable(),
});
export type ReviewSession = z.infer<typeof reviewSessionSchema>;
export function restoreReviewSession(value: unknown, identity: string): ReviewSession | null {
  const parsed = reviewSessionSchema.safeParse(value);
  return parsed.success && parsed.data.identity === identity ? parsed.data : null;
}

// Panels use Paseo's persisted tab JSON. Embedded remote reviews use a host/workspace/chat
// scoped browser entry; no snapshots, credentials or agent messages are stored here.
export function useReviewSession(identity: string, tab?: PluginTab) {
  const key = `mission-control:review-session:${identity}`;
  const [initial] = useState(() => {
    if (tab) return restoreReviewSession(tab.state, identity);
    try { return restoreReviewSession(JSON.parse(readClientStorage(key) ?? "null"), identity); }
    catch { return null; }
  });
  const last = useRef("");
  function save(state: ReviewSession) {
    const json = JSON.stringify(state);
    if (json === last.current) return;
    last.current = json;
    if (tab) tab.setState(JSON.parse(json));
    else { try { writeClientStorage(key, json); } catch { /* Storage can be disabled. */ } }
  }
  useEffect(() => () => tab?.setModified(false), [tab]);
  return { initial, save, snapshot: pinnedSnapshots.get(identity) ?? null,
    rememberSnapshot(snapshot: ReviewSnapshot) { pinnedSnapshots.delete(identity); pinnedSnapshots.set(identity, snapshot); while (pinnedSnapshots.size > 8) pinnedSnapshots.delete(pinnedSnapshots.keys().next().value!); } };
}
