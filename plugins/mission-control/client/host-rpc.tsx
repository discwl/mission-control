import type { PluginRpcContract } from "@getpaseo/plugin";
import { useRpc as useInstallationRpc } from "@getpaseo/plugin/client";
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import { copiesRevision, findCopy, subscribeCopies, type MissionControlCopy } from "./host-bridge";

type Target = { serverId: string; call(contract: PluginRpcContract, input: unknown): Promise<unknown> };
const HostRpc = createContext<Target | null>(null);

/** Views inside call this host's Mission Control instead of the one running this screen. */
export function HostRpcProvider({ copy, children }: { copy: MissionControlCopy; children: ReactNode }) {
  const value = useMemo<Target>(() => ({
    serverId: copy.serverId,
    call: (contract, input) => copy.supports(contract.name)
      ? copy.rpc(contract.name, input)
      : Promise.reject(new Error(`Mission Control on this host (${copy.version}) doesn't offer ${contract.name}. Update it.`)),
  }), [copy]);
  return <HostRpc.Provider value={value}>{children}</HostRpc.Provider>;
}

/**
 * The SDK's useRpc, except that inside a HostRpcProvider it calls that host's copy of Mission Control.
 * Views shared by the main page and an orchestrator's Host agents tab use this one.
 */
export function useRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(contract: PluginRpcContract<InputSchema, OutputSchema>): (input: ZodInput<InputSchema>) => Promise<ZodOutput<OutputSchema>> {
  const local = useInstallationRpc(contract);
  const target = useContext(HostRpc);
  return useMemo(() => target ? (input: ZodInput<InputSchema>) => target.call(contract, input) as Promise<ZodOutput<OutputSchema>> : local, [target, local, contract]);
}

/** The host's registered copy of Mission Control, following registrations as hosts connect and reload. */
export function useMissionControlCopy(serverId: string) {
  const revision = useSyncExternalStore(subscribeCopies, copiesRevision, copiesRevision);
  return useMemo(() => findCopy(serverId), [serverId, revision]);
}
