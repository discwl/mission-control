import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { readFleet, type FleetSnapshot } from "../shared/fleet";
import { buildV2Tasks, retainV2Hosts } from "./mission-control-v2-model";
import { kanbanTask } from "./kanban-model";

/** Sidebar and board observe one query, including its last-known host records. */
export function useKanbanData(installationId: string) {
  const read = useRpc(readFleet);
  const cache = useQueryClient();
  const key = ["mission-control", "fleet", installationId];
  const query = useQuery({
    queryKey: key,
    queryFn: async () => retainV2Hosts(await read({ refresh: true }), cache.getQueryData<FleetSnapshot>(key)),
    staleTime: 15_000, refetchInterval: 20_000, retry: false,
  });
  // An observation can expire even if the next network request hangs.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);
  const tasks = useMemo(() => query.data ? buildV2Tasks(query.data, { unconfirmed: query.isError, now }).map(kanbanTask) : [], [query.data, query.isError, now]);
  return { ...query, tasks, now };
}
