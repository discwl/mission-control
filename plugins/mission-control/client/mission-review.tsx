import { useRpc } from "./host-rpc";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { FlatList, Pressable, ScrollView, Text, View } from "react-native";
import {
  getReviewCommits,
  getReviewMarks,
  getReviewSnapshot,
  isMarkdownPath,
  isReviewScanPending,
  readReviewFile,
  reviewMarksKey,
  reviewSnapshotKey,
  setReviewFrom,
  setReviewMarks,
  setReviewSince,
  type CommentAnchor,
  type DiffLine,
  type ReviewComment,
  type ReviewFile,
  type ReviewHunk,
  type ReviewSnapshot,
  type Severity,
} from "../shared/review";
import { formatDateTime } from "./date-time";
import { ReviewFileMenu, ReviewItemActions, type ReviewItemTarget } from "./review-file-actions";
import { ReviewFilePreview } from "./review-file-preview";
import { MarkdownPreview } from "./markdown-preview";
import { CompactLink } from "./compact-link";
import { Breadcrumbs } from "./breadcrumbs";
import { anchorFor, anchorKey, placeComments, rowKeys } from "./review-anchors";
import { CommentCard, CommentComposer, SendBar, useReviewComments, useWorkspaceAgents } from "./review-comments";
import { useContextLines } from "./subagents";
import { fileGroups, severityLabel, splitPath, splitRows, type SplitRow } from "./review-rows";
import { LinkButton, mono, plural, SeverityBadge, severityColor, Tint, Toggle, type Colors } from "./review-ui";

type Row =
  | { key: string; type: "hunk"; hunk: ReviewHunk; index: number; total: number }
  | { key: string; type: "split"; row: SplitRow; contentId: string }
  | { key: string; type: "unified"; line: DiffLine; contentId: string }
  | { key: string; type: "comment"; comment: ReviewComment }
  | { key: string; type: "composer"; anchor: CommentAnchor; commentId?: string; initial?: string };
type Draft = { path: string; anchor: CommentAnchor | null; commentId?: string; initial?: string };
type LinePress = (line: DiffLine, contentId: string, side?: "old" | "new") => void;

const numberStyle = [mono, { width: 40, paddingRight: 6, textAlign: "right" as const }];

function LineNumber({ value, colors, onPress, label }: { value: number | null; colors: Colors; onPress?: () => void; label: string }) {
  if (!onPress || value === null) return <Text style={[numberStyle, { color: colors.foregroundMuted }]}>{value ?? ""}</Text>;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4}>
    <Text style={[numberStyle, { color: colors.accent, textDecorationLine: "underline" }]}>{value}</Text>
  </Pressable>;
}

function LineCell({ line, colors, side, contentId, onLinePress }: { line: DiffLine | null; colors: Colors; side: "old" | "new"; contentId: string; onLinePress: LinePress }) {
  const tint = line?.kind === "add" ? colors.statusSuccess : line?.kind === "del" ? colors.statusDanger : null;
  const number = line ? (side === "old" ? line.old : line.new) : null;
  return <View style={{ flex: 1, flexDirection: "row", minWidth: 0 }}>
    <Tint color={tint} />
    <LineNumber value={number} colors={colors} label={`Comment on ${side === "old" ? "old" : "new"} line ${number}`} onPress={line ? () => onLinePress(line, contentId, side) : undefined} />
    <Text selectable style={[mono, { flex: 1, color: colors.foreground }]}>{line ? line.text || " " : ""}</Text>
  </View>;
}

function DiffRow({ row, colors, total, split, onStep, isReviewed, onToggleReviewed, onLinePress }: {
  row: Exclude<Row, { type: "comment" | "composer" }>; colors: Colors; total: number; split: boolean; onStep?: (delta: number) => void;
  isReviewed: (id: string) => boolean; onToggleReviewed: (id: string, reviewed: boolean) => void; onLinePress: LinePress;
}) {
  if (row.type === "hunk") {
    const done = isReviewed(row.hunk.contentId);
    const stepButton = (delta: number, disabled: boolean, text: string, label: string) => onStep ? <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={() => onStep(delta)}
      style={{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", borderColor: colors.border, borderWidth: 1, borderRadius: 7, opacity: disabled ? 0.4 : 1 }}><Text style={{ color: colors.foreground }}>{text}</Text></Pressable> : null;
    return <View style={{ marginTop: row.index > 0 && !onStep ? 12 : 0, gap: 6, paddingVertical: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {stepButton(-1, row.index === 0, "‹", "Previous change block")}
        <View style={{ flex: 1, minWidth: 140 }}>
          <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 13 }}>Change block {row.index + 1}/{total}</Text>
          <Text numberOfLines={1} style={[mono, { color: colors.foregroundMuted, fontSize: 11 }]}>{row.hunk.header}{row.hunk.context ? ` ${row.hunk.context}` : ""}</Text>
        </View>
        <SeverityBadge severity={row.hunk.severity} colors={colors} />
        {stepButton(1, row.index >= total - 1, "›", "Next change block")}
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 11, flex: 1, minWidth: 160 }}>Why: {row.hunk.reasons.join(" · ")} · +{row.hunk.additions} −{row.hunk.deletions}</Text>
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: done }} accessibilityLabel={`Mark change block ${row.index + 1} reviewed`} onPress={() => onToggleReviewed(row.hunk.contentId, !done)}
          style={{ minHeight: 36, paddingHorizontal: 10, justifyContent: "center", borderRadius: 7, borderWidth: 1, borderColor: done ? colors.statusSuccess : colors.border }}>
          <Text style={{ color: done ? colors.statusSuccess : colors.foreground, fontSize: 12, fontWeight: "600" }}>{done ? "✓ Reviewed" : "Mark reviewed"}</Text>
        </Pressable>
      </View>
      {split ? <View style={{ flexDirection: "row" }}>
        <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: 11, fontWeight: "700" }}>OLD</Text>
        <Text style={{ flex: 1, color: colors.foregroundMuted, fontSize: 11, fontWeight: "700" }}>NEW</Text>
      </View> : null}
    </View>;
  }
  if (row.type === "unified") {
    const { line } = row;
    if (line.kind === "meta") return <Text style={[mono, { color: colors.foregroundMuted, fontStyle: "italic", paddingLeft: 86 }]}>{line.text}</Text>;
    const tint = line.kind === "add" ? colors.statusSuccess : line.kind === "del" ? colors.statusDanger : null;
    const press = () => onLinePress(line, row.contentId);
    const shown = line.kind === "del" ? line.old : line.new;
    return <View style={{ flexDirection: "row" }}>
      <Tint color={tint} />
      <Text style={[numberStyle, { color: colors.foregroundMuted }]}>{line.old ?? ""}</Text>
      <LineNumber value={line.new} colors={colors} label={`Comment on line ${shown}`} onPress={line.kind === "del" ? undefined : press} />
      <Pressable accessibilityRole="button" accessibilityLabel={`Comment on line ${shown}`} onPress={press} style={{ width: 14 }}>
        <Text style={[mono, { color: tint ?? colors.foregroundMuted }]}>{line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}</Text>
      </Pressable>
      <Text selectable style={[mono, { flex: 1, color: colors.foreground }]}>{line.text || " "}</Text>
    </View>;
  }
  if (row.row.meta !== null) return <Text style={[mono, { color: colors.foregroundMuted, fontStyle: "italic", paddingLeft: 46 }]}>{row.row.meta}</Text>;
  return <View style={{ flexDirection: "row", gap: 1, backgroundColor: colors.border }}>
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}><LineCell line={row.row.old} colors={colors} side="old" contentId={row.contentId} onLinePress={onLinePress} /></View>
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}><LineCell line={row.row.new} colors={colors} side="new" contentId={row.contentId} onLinePress={onLinePress} /></View>
  </View>;
}

function FileRow({ file, selected, reviewed, comments, colors, onPress, onActions }: { file: ReviewFile; selected: boolean; reviewed: number; comments: number; colors: Colors; onPress: () => void; onActions: (target: ReviewItemTarget) => void }) {
  const done = reviewed === file.reviewIds.length;
  const { dir, name } = splitPath(file.path);
  return <ReviewItemActions target={{ path: file.path, directory: false, deleted: file.change === "deleted" }} colors={colors} onOpen={onActions}><Pressable accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`${file.path}, ${severityLabel[file.severity]}`} onLongPress={() => onActions({ path: file.path, directory: false, deleted: file.change === "deleted" })} onPress={onPress}
    style={{ padding: 9, gap: 3, borderRadius: 7, borderLeftWidth: 3, borderLeftColor: selected ? colors.accent : "transparent", backgroundColor: selected ? colors.surface2 : "transparent" }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {done ? <Text style={{ color: colors.statusSuccess, fontSize: 13 }}>✓</Text> : null}
      <Text numberOfLines={1} style={{ color: done ? colors.foregroundMuted : colors.foreground, fontWeight: "600", fontSize: 13, flex: 1 }}>{name}</Text>
      {comments ? <Text style={{ color: colors.accent, fontSize: 11 }}>💬 {comments}</Text> : null}
      <SeverityBadge severity={file.severity} colors={colors} />
    </View>
    {dir ? <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11 }}>{dir}</Text> : null}
    <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
      {file.change !== "modified" ? `${file.change} · ` : ""}{plural(file.hunks.length, "change block")}{!done && reviewed ? ` (${reviewed} reviewed)` : ""} · <Text style={{ color: colors.statusSuccess }}>+{file.additions}</Text> <Text style={{ color: colors.statusDanger }}>−{file.deletions}</Text>
    </Text>
  </Pressable></ReviewItemActions>;
}

function FileTree({ files, colors, renderFile, onActions, prefix = "" }: {
  files: ReviewFile[]; colors: Colors; renderFile: (file: ReviewFile) => React.ReactNode; onActions: (target: ReviewItemTarget) => void; prefix?: string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const folders = new Map<string, ReviewFile[]>();
  const leaves: ReviewFile[] = [];
  for (const file of files) {
    const relative = file.path.slice(prefix.length);
    const separator = relative.indexOf("/");
    if (separator < 0) leaves.push(file);
    else {
      const name = relative.slice(0, separator);
      const contents = folders.get(name) ?? [];
      contents.push(file);
      folders.set(name, contents);
    }
  }
  function toggle(path: string) {
    setCollapsed(previous => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }
  return <View style={{ gap: 2 }}>
    {[...folders].sort(([left], [right]) => left.localeCompare(right)).map(([name, contents]) => {
      const path = `${prefix}${name}/`;
      const expanded = !collapsed.has(path);
      return <View key={path} style={{ gap: 2 }}>
        <ReviewItemActions target={{ path, directory: true }} colors={colors} onOpen={onActions}><Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? "Collapse" : "Expand"} folder ${path}`} onLongPress={() => onActions({ path, directory: true })} accessibilityState={{ expanded }} onPress={() => toggle(path)}
          style={{ minHeight: 36, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 9 }}>
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{expanded ? "▾" : "▸"}</Text>
          <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 12, fontWeight: "600", flex: 1 }}>{name}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{contents.length}</Text>
        </Pressable></ReviewItemActions>
        {expanded ? <View style={{ paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: colors.border }}>
          <FileTree files={contents} prefix={path} colors={colors} renderFile={renderFile} onActions={onActions} />
        </View> : null}
      </View>;
    })}
    {leaves.sort((left, right) => left.path.localeCompare(right.path)).map(file => <View key={file.path}>{renderFile(file)}</View>)}
  </View>;
}

function noLinesMessage(file: ReviewFile) {
  if (file.change === "binary") return "Binary file; no text changes to show.";
  if (file.change === "added") return "Empty new file.";
  if (file.change === "deleted") return "Empty file deleted.";
  return "No line changes (rename or mode change only).";
}

function scopeLabel(snapshot: ReviewSnapshot | null) {
  if (!snapshot) return "uncommitted changes";
  if (snapshot.fromCommit) return `${plural(snapshot.fromCommit.commits, "commit")} from ${snapshot.fromCommit.short} plus uncommitted changes`;
  if (snapshot.sinceCommit) return `everything since ${snapshot.sinceCommit.short}: ${plural(snapshot.sinceCommit.commits, "commit")} plus uncommitted changes`;
  return snapshot.base === "head" ? `uncommitted changes vs ${snapshot.head!.slice(0, 7)}` : "all files; the repository has no commits yet";
}

export function MissionReview({ serverId, localServerId = serverId, online, workspace, colors, compact, onChangeWorkspace, agentId: preferredAgentId }: {
  serverId: string; online: boolean; workspace: { id: string; name: string; projectName: string; hostLabel: string };
  colors: Colors; compact: boolean; onChangeWorkspace?: () => void; agentId?: string;
  // The host this Mission Control runs on, whose vault names the tasks in sub-agents' context lines.
  localServerId?: string;
}) {
  const read = useRpc(getReviewSnapshot);
  // Poll for changes, but keep showing the snapshot the user is reviewing until they refresh.
  const query = useQuery({
    queryKey: reviewSnapshotKey(serverId, workspace.id),
    queryFn: () => read({ serverId, workspaceId: workspace.id }),
    enabled: online, refetchInterval: online ? 10_000 : false, staleTime: 0, retry: false,
  });
  const [pinned, setPinned] = useState<ReviewSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | Severity>("all");
  const [mode, setMode] = useState<"blocks" | "full">("blocks");
  const [layout, setLayout] = useState<"split" | "unified">("split");
  const [pane, setPane] = useState<"files" | "comments">("files");
  const [fileView, setFileView] = useState<"list" | "tree">("tree");
  const [blockIndex, setBlockIndex] = useState(0);
  const [showDetail, setShowDetail] = useState(false);
  const [showReviewed, setShowReviewed] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [agentChoice, setAgentChoice] = useState<string | null>(preferredAgentId ?? null);
  // Stays on while moving between Markdown files; other files always show changes.
  const [showPreview, setShowPreview] = useState(false);
  const readFile = useRpc(readReviewFile);
  const [workingFile, setWorkingFile] = useState<{ serverId: string; workspaceId: string; path: string } | null>(null);
  const [itemTarget, setItemTarget] = useState<ReviewItemTarget | null>(null);
  const [markError, setMarkError] = useState<string | null>(null);
  const readMarks = useRpc(getReviewMarks);
  const writeMarks = useRpc(setReviewMarks);
  const writeFrom = useRpc(setReviewFrom);
  const writeSince = useRpc(setReviewSince);
  const readCommits = useRpc(getReviewCommits);
  const queryClient = useQueryClient();
  const marksQuery = useQuery({
    queryKey: reviewMarksKey(serverId, workspace.id),
    queryFn: () => readMarks({ serverId, workspaceId: workspace.id }),
    enabled: online, staleTime: 5_000, retry: false,
  });
  const commitsQuery = useQuery({
    queryKey: ["mission-control", "review-commits", serverId, workspace.id],
    queryFn: () => readCommits({ serverId, workspaceId: workspace.id }),
    enabled: online && scopeOpen, staleTime: 10_000, retry: false,
  });
  const review = useReviewComments(serverId, workspace.id, online);
  const agentsQuery = useWorkspaceAgents(serverId, workspace.id, online);
  // Task titles come from this Mission Control's vault, also for another host's workspace.
  const contextLine = useContextLines(serverId, localServerId, online);
  const agents = agentsQuery.data ?? [];
  const agentId = agents.some(agent => agent.id === agentChoice) ? agentChoice : agents[0]?.id ?? null;
  const agentName = (id: string | null) => agents.find(agent => agent.id === id)?.name ?? "an agent";

  const marks = marksQuery.data?.marks ?? {};
  const isReviewed = (id: string) => Boolean(marks[id]);
  const reviewedCount = (file: ReviewFile) => file.reviewIds.filter(isReviewed).length;
  const fileDone = (file: ReviewFile) => reviewedCount(file) === file.reviewIds.length;
  async function mark(ids: string[], reviewed: boolean) {
    setMarkError(null);
    try { queryClient.setQueryData(reviewMarksKey(serverId, workspace.id), await writeMarks({ serverId, workspaceId: workspace.id, ids, reviewed })); }
    catch (error) { setMarkError(error instanceof Error ? error.message : String(error)); }
  }
  async function chooseFrom(from: string | null, since: string | null = null) {
    setMarkError(null);
    try {
      const state = since ? await writeSince({ serverId, workspaceId: workspace.id, since }) : await writeFrom({ serverId, workspaceId: workspace.id, from });
      queryClient.setQueryData(reviewMarksKey(serverId, workspace.id), state);
      setScopeOpen(false);
      const result = await query.refetch();
      if (result.data) { setPinned(result.data); setSelectedPath(null); setBlockIndex(0); }
    } catch (error) { setMarkError(error instanceof Error ? error.message : String(error)); }
  }

  useEffect(() => { if (!pinned && query.data) setPinned(query.data); }, [pinned, query.data]);
  const snapshot = pinned;
  const stale = !!snapshot && !!query.data && query.data.fingerprint !== snapshot.fingerprint;
  const files = (snapshot?.files ?? []).filter(file => filter === "all" || file.severity === filter);
  const selected = snapshot?.files.find(file => file.path === selectedPath) ?? files[0] ?? null;
  const block = selected ? Math.min(blockIndex, Math.max(0, selected.hunks.length - 1)) : 0;
  // Split view is empty on one side for added or deleted files.
  const effectiveLayout = compact || selected?.change === "added" || selected?.change === "deleted" ? "unified" : layout;
  const additions = snapshot?.files.reduce((sum, file) => sum + file.additions, 0) ?? 0;
  const deletions = snapshot?.files.reduce((sum, file) => sum + file.deletions, 0) ?? 0;
  const unsent = review.comments.filter(comment => comment.status === "open" && !comment.delivery);
  const activeComments = review.comments.filter(comment => comment.status !== "resolved");
  const commentsIn = (path: string) => activeComments.filter(comment => comment.path === path).length;
  const placement = selected ? placeComments(selected, review.comments) : null;
  const canPreview = !!selected && isMarkdownPath(selected.path) && selected.change !== "deleted" && selected.change !== "binary";
  const previewing = showPreview && canPreview;
  const previewQuery = useQuery({
    queryKey: ["mission-control", "review-file", serverId, workspace.id, selected?.path ?? "", snapshot?.fingerprint ?? ""],
    queryFn: () => readFile({ serverId, workspaceId: workspace.id, path: selected!.path }),
    enabled: online && previewing, staleTime: 10_000, retry: false,
  });

  function refresh() { void query.refetch().then(result => { if (result.data) setPinned(result.data); }); }
  function select(path: string) { setWorkingFile(null); setSelectedPath(path); setBlockIndex(0); setShowDetail(true); setPane("files"); }
  const toReview = files.filter(file => !fileDone(file));
  const reviewedFiles = files.filter(fileDone);
  const nextToReview = toReview.find(file => file.path !== selected?.path) ?? null;
  function toggleBlock(id: string, reviewed: boolean) {
    void mark([id], reviewed).then(() => {
      // In block view, move on to the next change block after marking one.
      if (reviewed && mode === "blocks" && selected && block < selected.hunks.length - 1) setBlockIndex(block + 1);
    });
  }
  const onLinePress: LinePress = (line, contentId, side) => {
    const anchor = anchorFor(line, contentId, side);
    if (anchor && selected) { review.clearError(); setDraft({ path: selected.path, anchor }); }
  };
  async function saveDraft(body: string) {
    if (!draft) return;
    if (await review.save({ commentId: draft.commentId, path: draft.path, anchor: draft.anchor, body })) setDraft(null);
  }
  function openComment(comment: ReviewComment) {
    const index = snapshot?.files.find(file => file.path === comment.path)?.hunks.findIndex(hunk => hunk.contentId === comment.anchor?.contentId) ?? -1;
    setSelectedPath(comment.path); setBlockIndex(Math.max(0, index)); setShowDetail(true); setPane("files");
  }
  function sendAll() {
    if (!agentId || !unsent.length) return;
    void review.send({ agentId, commentIds: unsent.slice(0, 50).map(comment => comment.commentId), workspaceName: workspace.name, scopeLabel: scopeLabel(snapshot) });
  }

  // Diff rows, with each line's comments and any open composer right below it.
  const rows: Row[] = [];
  if (selected && placement && !previewing) {
    const shownComments = new Set<string>();
    const after = (keys: string[], at: string) => {
      for (const key of keys) for (const comment of placement.byLine.get(key) ?? []) {
        if (shownComments.has(comment.commentId)) continue;
        shownComments.add(comment.commentId);
        if (draft?.commentId === comment.commentId && draft.anchor) rows.push({ key: `edit-${comment.commentId}`, type: "composer", anchor: draft.anchor, commentId: comment.commentId, initial: draft.initial });
        else rows.push({ key: `c-${comment.commentId}`, type: "comment", comment });
      }
      if (draft && !draft.commentId && draft.anchor && draft.path === selected.path && keys.includes(anchorKey(draft.anchor.side, draft.anchor.line))) {
        rows.push({ key: `draft-${at}`, type: "composer", anchor: draft.anchor });
      }
    };
    const shown = mode === "blocks" ? selected.hunks.slice(block, block + 1) : selected.hunks;
    shown.forEach((hunk, offset) => {
      const index = mode === "blocks" ? block : offset;
      rows.push({ key: `h${index}`, type: "hunk", hunk, index, total: selected.hunks.length });
      if (effectiveLayout === "split") {
        for (const row of splitRows(hunk.lines, `${index}-`)) {
          rows.push({ key: row.key, type: "split", row, contentId: hunk.contentId });
          after([...rowKeys(row.old, "old"), ...rowKeys(row.new, "new")], row.key);
        }
      } else hunk.lines.forEach((line, lineIndex) => {
        rows.push({ key: `${index}-${lineIndex}`, type: "unified", line, contentId: hunk.contentId });
        after(rowKeys(line), `${index}-${lineIndex}`);
      });
    });
  }

  // A slow scan keeps running on the host; the 10-second poll collects it, so it isn't an error.
  const scanning = query.isError && isReviewScanPending(query.error);
  const state = !online ? { label: "HOST OFFLINE", color: colors.statusWarning }
    : scanning && !snapshot ? { label: "READING CHANGES", color: colors.foregroundMuted }
    : query.isError && !snapshot ? { label: "ERROR", color: colors.statusDanger }
    : !snapshot ? { label: "LOADING", color: colors.foregroundMuted }
    : stale ? { label: "OUT OF DATE", color: colors.statusWarning }
    : query.isError && !scanning ? { label: "CAN'T CHECK FOR CHANGES", color: colors.statusWarning }
    : { label: "CURRENT", color: colors.statusSuccess };

  const scopePicker = scopeOpen ? <View style={{ borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 8, gap: 2, maxHeight: 320 }}>
    <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Review everything from a commit onward, including uncommitted changes. Marks and comments carry over.</Text>
    <ScrollView style={{ maxHeight: 280 }} nestedScrollEnabled>
      {marksQuery.data?.branchBase ? <Pressable accessibilityRole="radio" accessibilityState={{ selected: marksQuery.data.since === marksQuery.data.branchBase }} onPress={() => void chooseFrom(null, marksQuery.data!.branchBase)} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 6, gap: 1 }}>
        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: marksQuery.data.since === marksQuery.data.branchBase ? "700" : "400" }}>Everything since this task branched</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>All the task's commits plus uncommitted changes, from <Text style={mono}>{marksQuery.data.branchBase.slice(0, 7)}</Text></Text>
      </Pressable> : null}
      <Pressable accessibilityRole="radio" accessibilityState={{ selected: !marksQuery.data?.from && !marksQuery.data?.since }} onPress={() => void chooseFrom(null)} style={{ minHeight: 40, justifyContent: "center", paddingHorizontal: 6 }}>
        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: !marksQuery.data?.from && !marksQuery.data?.since ? "700" : "400" }}>Uncommitted changes only</Text>
      </Pressable>
      {commitsQuery.isPending ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, padding: 6 }}>Loading commits…</Text> : null}
      {commitsQuery.isError ? <Text style={{ color: colors.statusDanger, fontSize: 12, padding: 6 }}>{commitsQuery.error instanceof Error ? commitsQuery.error.message : String(commitsQuery.error)}</Text> : null}
      {commitsQuery.data?.commits.map((commit, index) => <Pressable key={commit.sha} accessibilityRole="radio" accessibilityState={{ selected: marksQuery.data?.from === commit.sha }} onPress={() => void chooseFrom(commit.sha)}
        style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 6, gap: 1 }}>
        <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: 13, fontWeight: marksQuery.data?.from === commit.sha ? "700" : "400" }}><Text style={mono}>{commit.short}</Text> {commit.subject}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Include {plural(index + 1, "commit")} · {commit.author} · {formatDateTime(commit.date)}</Text>
      </Pressable>)}
    </ScrollView>
  </View> : null;

  const fileMenu = <>{itemTarget ? <ReviewFileMenu key={`${serverId}:${workspace.id}:${itemTarget.path}:${itemTarget.directory}`} target={itemTarget} serverId={serverId} workspaceId={workspace.id} online={online} colors={colors}
    onClose={() => setItemTarget(null)} onOpenFile={path => setWorkingFile({ serverId, workspaceId: workspace.id, path })}
    onDiscarded={() => { setSelectedPath(null); setDraft(null); setWorkingFile(null); refresh(); void queryClient.invalidateQueries({ queryKey: ["mission-control", "review-file", serverId, workspace.id] }); }} /> : null}
    {workingFile && workingFile.serverId === serverId && workingFile.workspaceId === workspace.id ? <ReviewFilePreview key={`${serverId}:${workspace.id}:${workingFile.path}`} {...workingFile} online={online} colors={colors} compact={compact} onClose={() => setWorkingFile(null)} /> : null}
  </>;

  const header = <View style={{ gap: 8, borderBottomColor: colors.border, borderBottomWidth: 1, paddingBottom: 10 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <Text style={{ color: colors.foreground, fontSize: 18, fontWeight: "700" }}>Review</Text>
      <View style={{ borderColor: state.color, borderWidth: 1, borderRadius: 5, paddingHorizontal: 7, paddingVertical: 2 }}><Text style={{ color: state.color, fontSize: 10, fontWeight: "700" }}>{state.label}</Text></View>
      <View style={{ flex: 1 }} />
      <CompactLink iconOnly icon="RefreshCw" label={query.isFetching ? "Checking…" : "Refresh"} accessibilityLabel="Refresh review" colors={colors} disabled={!online || query.isFetching} onPress={refresh} />
      {onChangeWorkspace ? <CompactLink label="Change workspace" colors={colors} onPress={onChangeWorkspace} /> : null}
    </View>
    <Breadcrumbs colors={colors} segments={[workspace.hostLabel, workspace.projectName, workspace.name]} />
    {snapshot ? <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12, flexShrink: 1 }}>
        Reviewing <Text style={{ color: colors.foreground }}>{scopeLabel(snapshot)}</Text>{snapshot.branch ? ` on ${snapshot.branch}` : ""} · snapshot {formatDateTime(snapshot.generatedAt)} · {snapshot.files.length} files <Text style={{ color: colors.statusSuccess }}>+{additions}</Text> <Text style={{ color: colors.statusDanger }}>−{deletions}</Text>
      </Text>
      {snapshot.head ? <LinkButton label={scopeOpen ? "Close" : "Change what to review"} onPress={() => setScopeOpen(!scopeOpen)} colors={colors} /> : null}
    </View> : null}
    {scopePicker}
    {snapshot?.baseWarning ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>{snapshot.baseWarning}</Text> : null}
    {stale ? <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text style={{ color: colors.statusWarning, fontSize: 12, flex: 1 }}>Files changed since this snapshot.</Text><CompactLink iconOnly icon="RefreshCw" label="Refresh latest changes" colors={colors} disabled={!online || query.isFetching} onPress={refresh} /></View> : null}
    {scanning ? (snapshot ? null : <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Reading this workspace's changes. Git is slow on this host, so this can take a minute.</Text>)
      : query.isError ? <Text accessibilityRole="alert" style={{ color: snapshot ? colors.statusWarning : colors.statusDanger, fontSize: 12 }}>{query.error instanceof Error ? query.error.message : String(query.error)}</Text> : null}
    {snapshot && snapshot.files.length ? <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600" }}>Reviewed {snapshot.files.filter(fileDone).length} of {snapshot.files.length} files · 💬 {unsent.length} unsent, {review.comments.filter(comment => comment.status === "sent").length} sent</Text> : null}
    <SendBar agents={agents} agentId={agentId} onChooseAgent={setAgentChoice} pending={unsent.length} busy={review.busy} onSend={sendAll} colors={colors} contextLine={contextLine} />
    {marksQuery.isError ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning, fontSize: 12 }}>Review data unavailable: {marksQuery.error instanceof Error ? marksQuery.error.message : String(marksQuery.error)}</Text> : null}
    {review.loadError ? <Text accessibilityRole="alert" style={{ color: colors.statusWarning, fontSize: 12 }}>Comments unavailable: {review.loadError}</Text> : null}
    {markError || review.error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{markError || review.error}</Text> : null}
    {snapshot?.omittedFiles ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>{snapshot.omittedFiles} more new files are not shown.</Text> : null}
  </View>;

  const commentsPane = <View style={{ gap: 4 }}>
    {!review.comments.length ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>No comments yet. Tap a line number to comment on a line, or use "Comment on file".</Text> : null}
    {review.comments.filter(comment => comment.status !== "resolved").map(comment => <CommentCard key={comment.commentId} comment={comment} colors={colors} agentName={agentName} busy={review.busy} showPath
      onAction={action => void review.update(comment.commentId, action)} onOpen={() => openComment(comment)} />)}
    {review.comments.some(comment => comment.status === "resolved") ? <LinkButton label={`${showResolved ? "Hide" : "Show"} resolved (${review.comments.filter(comment => comment.status === "resolved").length})`} onPress={() => setShowResolved(!showResolved)} colors={colors} /> : null}
    {showResolved ? review.comments.filter(comment => comment.status === "resolved").map(comment => <CommentCard key={comment.commentId} comment={comment} colors={colors} agentName={agentName} busy={review.busy} showPath
      onAction={action => void review.update(comment.commentId, action)} />) : null}
  </View>;

  const list = <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 4 }} scrollEnabled={!compact}>
    <Toggle label="Review list" options={[["files", `Files ${snapshot?.files.length ?? 0}`], ["comments", `Comments ${activeComments.length}`]]} value={pane} onChange={setPane} colors={colors} />
    {pane === "comments" ? commentsPane : <>
      <Toggle label="File view" options={[["list", "List"], ["tree", "Tree"]]} value={fileView} onChange={setFileView} colors={colors} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 6 }}>
        {(["all", "high", "medium", "low", "info"] as const).map(key => {
          const count = key === "all" ? snapshot?.files.length ?? 0 : snapshot?.files.filter(file => file.severity === key).length ?? 0;
          return <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected: filter === key }} onPress={() => setFilter(key)}
            style={{ minHeight: 36, paddingHorizontal: 10, justifyContent: "center", borderRadius: 6, borderWidth: 1, borderColor: filter === key ? colors.accent : colors.border }}>
            <Text style={{ color: filter === key ? colors.foreground : colors.foregroundMuted, fontSize: 12 }}>{key === "all" ? "All" : severityLabel[key]} {count}</Text>
          </Pressable>;
        })}
      </ScrollView>
      {snapshot && snapshot.files.length === 0 ? <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>No changes to review. {snapshot.head ? "Use \"Change what to review\" to review recent commits." : ""}</Text> : null}
      {snapshot && snapshot.files.length ? <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "700", marginTop: 6 }}>To review · {toReview.length}</Text> : null}
      {snapshot && snapshot.files.length && !toReview.length ? <Text style={{ color: colors.statusSuccess, fontSize: 12 }}>Everything here is reviewed.</Text> : null}
      {fileView === "tree" ? <FileTree files={toReview} colors={colors} onActions={setItemTarget} renderFile={file => <FileRow file={file} selected={selected?.path === file.path} reviewed={reviewedCount(file)} comments={commentsIn(file.path)} colors={colors} onActions={setItemTarget} onPress={() => select(file.path)} />} /> : fileGroups(toReview).map(group => <View key={group.severity} style={{ gap: 2 }}>
        <Text style={{ color: severityColor(group.severity, colors), fontSize: 11, fontWeight: "700", marginTop: 6 }}>{severityLabel[group.severity]} · {group.files.length}</Text>
        {group.files.map(file => <FileRow key={file.path} file={file} selected={selected?.path === file.path} reviewed={reviewedCount(file)} comments={commentsIn(file.path)} colors={colors} onActions={setItemTarget} onPress={() => select(file.path)} />)}
      </View>)}
      {reviewedFiles.length ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: showReviewed }} onPress={() => setShowReviewed(!showReviewed)} style={{ minHeight: 40, justifyContent: "center", marginTop: 8 }}>
        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "700" }}>{showReviewed ? "▾" : "▸"} Reviewed · {reviewedFiles.length}</Text>
      </Pressable> : null}
      {showReviewed ? fileView === "tree" ? <FileTree files={reviewedFiles} colors={colors} onActions={setItemTarget} renderFile={file => <FileRow file={file} selected={selected?.path === file.path} reviewed={reviewedCount(file)} comments={commentsIn(file.path)} colors={colors} onActions={setItemTarget} onPress={() => select(file.path)} />} /> : reviewedFiles.map(file => <FileRow key={file.path} file={file} selected={selected?.path === file.path} reviewed={reviewedCount(file)} comments={commentsIn(file.path)} colors={colors} onActions={setItemTarget} onPress={() => select(file.path)} />) : null}
    </>}
  </ScrollView>;

  const fileDraft = draft && !draft.anchor && selected && draft.path === selected.path ? draft : null;
  const detailHeader = selected && placement ? <View style={{ gap: 8, paddingBottom: 8 }}>
    {compact ? <CompactLink colors={colors} label={"← Files"} accessibilityRole="button" onPress={() => setShowDetail(false)} /> : null}
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text selectable style={{ color: colors.foreground, fontSize: 15, fontWeight: "700", flex: 1 }}>{selected.path}</Text>
      <SeverityBadge severity={selected.severity} colors={colors} />
    </View>
    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
      {selected.oldPath ? `Renamed from ${selected.oldPath} · ` : ""}{selected.change} · {plural(selected.hunks.length, "change block")} · +{selected.additions} −{selected.deletions}{selected.reasons.length ? ` · ${selected.reasons.join(", ")}` : ""}
    </Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={fileDone(selected) ? "Mark file not reviewed" : "Mark file reviewed"} onPress={() => void mark(selected.reviewIds, !fileDone(selected))}
        style={{ minHeight: 40, paddingHorizontal: 12, justifyContent: "center", borderRadius: 7, backgroundColor: fileDone(selected) ? "transparent" : colors.accent, borderWidth: 1, borderColor: fileDone(selected) ? colors.statusSuccess : colors.accent }}>
        <Text style={{ color: fileDone(selected) ? colors.statusSuccess : colors.accentForeground, fontSize: 12, fontWeight: "600" }}>{fileDone(selected) ? "✓ File reviewed · undo" : "Mark file reviewed"}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Comment on file" onPress={() => { review.clearError(); setDraft({ path: selected.path, anchor: null }); }}
        style={{ minHeight: 40, paddingHorizontal: 12, justifyContent: "center", borderRadius: 7, borderWidth: 1, borderColor: colors.border }}>
        <Text style={{ color: colors.foreground, fontSize: 12 }}>💬 Comment on file</Text>
      </Pressable>
      {nextToReview ? <Pressable accessibilityRole="button" onPress={() => select(nextToReview.path)} style={{ minHeight: 40, paddingHorizontal: 12, justifyContent: "center", borderRadius: 7, borderWidth: 1, borderColor: colors.border }}>
        <Text style={{ color: colors.foreground, fontSize: 12 }}>Next to review → {splitPath(nextToReview.path).name}</Text>
      </Pressable> : null}
    </View>
    {fileDraft ? <CommentComposer key={fileDraft.commentId ?? "file"} label="Comment on this file" initial={fileDraft.initial} colors={colors} busy={review.busy} indent={false} onSave={body => void saveDraft(body)} onCancel={() => setDraft(null)} /> : null}
    {placement.fileLevel.map(comment => draft?.commentId === comment.commentId && !draft.anchor
      ? null
      : <CommentCard key={comment.commentId} comment={comment} colors={colors} agentName={agentName} busy={review.busy} onAction={action => void review.update(comment.commentId, action)}
          onEdit={() => setDraft({ path: comment.path, anchor: null, commentId: comment.commentId, initial: comment.body })} showPath={false} />)}
    {placement.outdated.length ? <View style={{ gap: 2 }}>
      <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Outdated: the line these comments point to has changed.</Text>
      {placement.outdated.map(comment => <CommentCard key={comment.commentId} comment={comment} colors={colors} agentName={agentName} busy={review.busy} showPath onAction={action => void review.update(comment.commentId, action)} />)}
    </View> : null}
    {selected.truncated ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>This file is very large; only the first 4,000 lines are shown.</Text> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      {canPreview ? <Toggle label="Show" options={[["changes", "Changes"], ["preview", "Preview"]]} value={previewing ? "preview" : "changes"} onChange={value => setShowPreview(value === "preview")} colors={colors} /> : null}
      {selected.hunks.length && !previewing ? <>
        <Toggle label="Diff layout" options={[["blocks", "Change blocks"], ["full", "Full file changes"]]} value={mode} onChange={setMode} colors={colors} />
        {!compact && selected.change !== "added" && selected.change !== "deleted" ? <Toggle label="Columns" options={[["split", "Split"], ["unified", "Unified"]]} value={layout} onChange={setLayout} colors={colors} /> : null}
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Tap a line number to comment.</Text>
      </> : null}
    </View>
    {!selected.hunks.length && !previewing ? <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{noLinesMessage(selected)}</Text> : null}
  </View> : <Text style={{ color: colors.foregroundMuted }}>Select a file to review.</Text>;

  const detail = <FlatList data={rows} keyExtractor={row => row.key} scrollEnabled={!compact} initialNumToRender={60} windowSize={9} extraData={[marks, review.comments, draft, review.busy]}
    ListHeaderComponent={detailHeader} style={{ flex: compact ? undefined : 1, minHeight: 0 }} keyboardShouldPersistTaps="handled"
    ListFooterComponent={previewing ? <View style={{ borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 14, gap: 8 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Preview of the file as it is now. Switch to Changes to comment on lines.</Text>
      {previewQuery.isPending ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Loading preview…</Text> : null}
      {previewQuery.isError ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{previewQuery.error instanceof Error ? previewQuery.error.message : String(previewQuery.error)}</Text> : null}
      {previewQuery.data?.truncated ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Only the first 512 KB are shown.</Text> : null}
      {previewQuery.data ? isMarkdownPath(selected!.path) ? <MarkdownPreview content={previewQuery.data.text} colors={colors} /> : <ScrollView horizontal><Text selectable style={[mono, { color: colors.foreground }]}>{previewQuery.data.text}</Text></ScrollView> : null}
    </View> : null}
    renderItem={({ item }) => {
      if (item.type === "comment") return <CommentCard comment={item.comment} colors={colors} agentName={agentName} busy={review.busy} onAction={action => void review.update(item.comment.commentId, action)}
        onEdit={() => setDraft({ path: item.comment.path, anchor: item.comment.anchor, commentId: item.comment.commentId, initial: item.comment.body })} />;
      if (item.type === "composer") return <CommentComposer key={item.key} label={`Comment on line ${item.anchor.line}${item.anchor.side === "old" ? " (removed)" : ""}`} initial={item.initial} colors={colors} busy={review.busy}
        onSave={body => void saveDraft(body)} onCancel={() => setDraft(null)} />;
      return <DiffRow row={item} colors={colors} total={selected?.hunks.length ?? 0} split={effectiveLayout === "split"} isReviewed={isReviewed} onToggleReviewed={toggleBlock} onLinePress={onLinePress}
        onStep={mode === "blocks" ? delta => setBlockIndex(Math.max(0, Math.min((selected?.hunks.length ?? 1) - 1, block + delta))) : undefined} />;
    }} />;

  if (!snapshot) return <View style={{ gap: 12 }}>{header}{fileMenu}</View>;
  if (compact) return <View style={{ gap: 12 }}>{header}{fileMenu}{showDetail && selected && pane === "files" ? detail : list}</View>;
  return <View style={{ flex: 1, minHeight: 0, gap: 12 }}>
    {header}{fileMenu}
    <View style={{ flex: 1, minHeight: 0, flexDirection: "row", gap: 14 }}>
      <View style={{ width: 300, minHeight: 0 }}>{list}</View>
      <View style={{ flex: 1, minHeight: 0, borderLeftColor: colors.border, borderLeftWidth: 1, paddingLeft: 14 }}>{detail}</View>
    </View>
  </View>;
}
