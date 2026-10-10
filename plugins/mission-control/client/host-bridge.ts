import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import * as agentNames from "../shared/agent-names";
import * as decisions from "../shared/decisions";
import * as launch from "../shared/launch";
import * as merge from "../shared/merge";
import { getHostIdentity } from "../shared/orchestrator";
import * as paseoMetadata from "../shared/paseo-metadata";
import * as pullRequest from "../shared/pull-request";
import * as questions from "../shared/questions";
import * as review from "../shared/review";
import * as runs from "../shared/runs";
import * as subagents from "../shared/subagents";
import * as taskSummary from "../shared/task-summary";
import * as tasks from "../shared/tasks";
import * as vault from "../shared/vault";
import { missionControlVersion } from "../shared/version";

// Paseo runs every connected host's copy of Mission Control in this one app. Each copy registers here, so
// a view of another host (an orchestrator's Host agents tab) can ask that host's copy, the one next to its
// vault and checkouts, for tasks, documents, decisions and review. Raise the protocol when calls change shape.
export const BRIDGE_PROTOCOL = 1;

export type MissionControlCopy = {
  protocol: number;
  version: string;
  serverId: string;
  supports(name: string): boolean;
  /** Calls one of this copy's RPCs on its own host. */
  rpc(name: string, input: unknown): Promise<unknown>;
};

type Registry = { copies: Map<string, MissionControlCopy>; listeners: Set<() => void>; revision: number };
const REGISTRY_KEY = "__missionControlCopies";

// Copies from different hosts can run different versions, so the registry keeps this minimal shape forever.
function registry(): Registry {
  const scope = globalThis as unknown as Record<string, Registry | undefined>;
  return (scope[REGISTRY_KEY] ??= { copies: new Map(), listeners: new Set(), revision: 0 });
}

function changed(target: Registry) {
  target.revision++;
  for (const listener of [...target.listeners]) listener();
}

export function registerCopy(copy: MissionControlCopy): () => void {
  const target = registry();
  target.copies.set(copy.serverId, copy);
  changed(target);
  return () => {
    if (target.copies.get(copy.serverId) !== copy) return;
    target.copies.delete(copy.serverId);
    changed(target);
  };
}

/** The registered copy for a host, or why there isn't a usable one: none registered, or one side is older. */
export function findCopy(serverId: string): { copy: MissionControlCopy } | { missing: "none" | "older" | "newer" } {
  const copy = registry().copies.get(serverId);
  if (!copy) return { missing: "none" };
  if (copy.protocol < BRIDGE_PROTOCOL) return { missing: "older" };
  return copy.protocol > BRIDGE_PROTOCOL ? { missing: "newer" } : { copy };
}

export function subscribeCopies(listener: () => void): () => void {
  const target = registry();
  target.listeners.add(listener);
  return () => { target.listeners.delete(listener); };
}

export function copiesRevision(): number {
  return registry().revision;
}

const isContract = (value: unknown): value is PluginRpcContract => {
  const candidate = value as Partial<PluginRpcContract> | null;
  return typeof candidate === "object" && candidate !== null && typeof candidate.name === "string"
    && typeof candidate.input?.parse === "function" && typeof candidate.output?.parse === "function";
};

// What another host's view may ask this copy for: the Tasks, Docs, Review and Attention views' calls.
// Setup, tools, settings, updates and cleanup stay with each host's own Mission Control.
export const bridgeContracts: ReadonlyMap<string, PluginRpcContract> = new Map(
  [tasks, taskSummary, runs, launch, decisions, questions, merge, pullRequest, paseoMetadata, review, vault, subagents, agentNames]
    .flatMap(module => Object.values(module).filter(isContract).map(contract => [contract.name, contract] as const)),
);

/**
 * Registers this installation's copy under its host's server ID once the server says what that is.
 * Retries every 30 seconds until it does; disposal removes the registration.
 */
export function startCopyRegistration(client: Pick<PluginClientContext, "rpc">, { contracts = bridgeContracts, retryMs = 30_000 } = {}): () => void {
  let stopped = false;
  let unregister: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function attempt() {
    try {
      const { serverId } = await client.rpc(getHostIdentity, {});
      if (stopped) return;
      unregister = registerCopy({
        protocol: BRIDGE_PROTOCOL, version: missionControlVersion, serverId,
        supports: name => contracts.has(name),
        rpc: async (name, input) => {
          const contract = contracts.get(name);
          if (!contract) throw new Error(`This host's Mission Control (${missionControlVersion}) doesn't offer ${name}. Update it.`);
          return client.rpc(contract, input as never);
        },
      });
    } catch {
      if (!stopped) timer = setTimeout(() => void attempt(), retryMs);
    }
  }
  void attempt();
  return () => {
    stopped = true;
    clearTimeout(timer);
    unregister?.();
  };
}
