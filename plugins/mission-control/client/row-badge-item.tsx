import { useRpc, type PluginClientContext, type PluginWorkspaceRowBadgeItemProps } from "@getpaseo/plugin/client";
import * as pluginUi from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { readRowBadges, type RowBadge } from "../shared/row-badges";

// Paseo 0.16 apps export WorkspaceRowBadge and offer addWorkspaceRowBadgeItem; older apps have neither.
const WorkspaceRowBadge = (pluginUi as Partial<typeof pluginUi>).WorkspaceRowBadge;

// Each row's query keeps its own one-minute timer, and rows mount at different times. The last answer per host is
// reused for 50 seconds, so a host is asked at most about once a minute however many rows refresh.
const recent = new Map<string, { at: number; badges: Map<string, RowBadge> }>();

function TaskStateBadge({ workspaceId, host }: PluginWorkspaceRowBadgeItemProps) {
  const read = useRpc(readRowBadges);
  // Every row of a host shares this one query. The host computes the badges, so the device receives a short list and
  // the map is built once per fetch, not once per row.
  const query = useQuery({
    queryKey: ["mission-control", "row-badges", host.id],
    queryFn: async () => {
      const last = recent.get(host.id);
      if (last && Date.now() - last.at < 50_000) return last.badges;
      const badges = new Map<string, RowBadge>((await read({})).badges.map(({ workspaceId: id, ...badge }) => [id, badge]));
      recent.set(host.id, { at: Date.now(), badges });
      return badges;
    },
    staleTime: 50_000, refetchInterval: 60_000, retry: false,
  });
  const badge = query.data?.get(workspaceId);
  if (!badge || !WorkspaceRowBadge) return null;
  return <WorkspaceRowBadge icon={badge.icon} label={badge.label} tone={badge.tone} accessibilityLabel={badge.accessibilityLabel} />;
}

/** Paseo 0.16: each task's state on its sidebar workspace row. Nothing registers on an older app. */
export function registerRowBadges(client: PluginClientContext): () => void {
  const add = (client as Partial<PluginClientContext>).addWorkspaceRowBadgeItem;
  if (typeof add !== "function" || !WorkspaceRowBadge) return () => {};
  const remove = add.call(client, { id: "task-state", title: "Mission Control task state", icon: "SquareKanban", Component: TaskStateBadge });
  return () => { void remove(); };
}
