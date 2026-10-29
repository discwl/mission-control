import type { PluginServerContext } from "@getpaseo/plugin/server";
import { acknowledgeFleetDispatch, configureSupervisor, fleetSnapshotSchema, pauseFleet, readFleet, readFleetHost, reconcileFleet, setFleetQueue, supervisorEntrySchema, type FleetSnapshot } from "../shared/fleet";
import { chooseNextTask, coordinatorCandidates, managedTasks, taskFingerprint } from "../shared/fleet-model";
import { hideSecrets } from "../shared/secret-mask";
import { isQuiet } from "../shared/agent-tree";
import { collectFleetHost, fleetDirectory, toFleetAgent, type FleetHostDeps } from "./fleet-host";
import { createFleetStore, fleetEvent } from "./fleet-store";
import { createFleetSupervisor } from "./fleet-supervisor";
import { readRemoteFleet, withFleetConnection } from "./fleet-transport";
import { readOrchestratorBindings } from "./orchestrator";
import { createOrchestratorWorkStore } from "./orchestrator-work";
import { daemonServerId } from "./agent-names";

import { registerPipelineRuntime } from "./pipeline-runtime";

export function registerFleet(server: PluginServerContext, deps: Omit<FleetHostDeps, "stoppedAgents">) {
  const store = createFleetStore(); const links = createOrchestratorWorkStore();
  let disposed = false; let cached: FleetSnapshot | null = null; let loading: Promise<FleetSnapshot> | null = null;
  let heartbeat = { checkedAt: null as string | null, error: null as string | null };
  const hostDeps = { ...deps, stoppedAgents: async () => (await store.read()).stoppedAgentIds };
  server.handle(readFleetHost, async ({ serverId }, { paseo }) => {
    if (serverId !== await daemonServerId()) throw new Error("This vault belongs to a different host.");
    return collectFleetHost(paseo, serverId, hostDeps);
  });
  async function collect(): Promise<FleetSnapshot> {
    return withFleetConnection(async (paseo, client, serverId) => {
      const directory = await fleetDirectory(paseo, serverId);
      const candidateIds = new Set(coordinatorCandidates(directory.agents.map(toFleetAgent)).map(agent => agent.id));
      const roots = directory.agents.filter(agent => candidateIds.has(agent.id));
      const bindings = await readOrchestratorBindings(paseo, directory.workspaces.map(workspace => workspace.id), { localServerId: async () => serverId });
      const coordinators = await Promise.all(roots.filter(agent => bindings.bindings[agent.workspaceId!]).map(async agent => {
        const binding = bindings.bindings[agent.workspaceId!];
        return { agentId: agent.id, workspaceId: agent.workspaceId!, name: toFleetAgent(agent).name,
          remoteServerId: binding.serverId, hostLabel: binding.label, agent: toFleetAgent(agent),
          links: await links.list({ serverId, agentId: agent.id, remoteServerId: binding.serverId }) };
      }));
      const targets = new Map(Object.values(bindings.bindings).map(item => [item.serverId, item.label]));
      const hosts = await Promise.all([...targets].map(async ([target, label]) => {
        try { return { serverId: target, label, snapshot: await readRemoteFleet(client, target, { localServerId: serverId, coordinators: coordinators.filter(item => item.remoteServerId === target) }), error: null }; }
        catch (error) { return { serverId: target, label, snapshot: null, error: hideSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500) }; }
      }));
      const warnings = directory.complete ? [] : ["Coordinator roster is truncated. Automatic dispatch is disabled."];
      for (const [workspace, problem] of Object.entries(bindings.problems)) warnings.push(`${workspace}: ${problem}`);
      return fleetSnapshotSchema.parse({ serverId, observedAt: new Date().toISOString(), coordinators, hosts, state: await store.read(), warnings });
    });
  }
  async function snapshot(refresh = false): Promise<FleetSnapshot> {
    if (!refresh && cached && Date.now() - Date.parse(cached.observedAt) < 10_000) return { ...cached, state: await store.read() };
    if (!loading) loading = collect().then(async result => {
      const observed: Record<string, string> = {};
      const changes: { coordinatorId: string; remoteServerId: string; taskId: string; title: string }[] = [];
      for (const coordinator of result.coordinators) {
        const host = result.hosts.find(host => host.serverId === coordinator.remoteServerId)?.snapshot;
        if (!host) continue;
        for (const entry of managedTasks(result.serverId, coordinator, host)) {
          const key = `${coordinator.agentId}:${host.serverId}:${entry.task.taskId}`;
          observed[key] = taskFingerprint(entry);
          if (result.state.seen[key] && result.state.seen[key] !== observed[key]) changes.push({ coordinatorId: coordinator.agentId, remoteServerId: host.serverId, taskId: entry.task.taskId, title: entry.task.title });
        }
      }
      if (Object.entries(observed).some(([key, value]) => result.state.seen[key] !== value)) result.state = await store.update(state => {
        for (const change of changes) fleetEvent(state, { ...change, kind: "progress", message: `Workflow records changed: ${change.title}` });
        state.seen = Object.fromEntries(Object.entries({ ...state.seen, ...observed }).slice(-5000));
      });
      cached = result; return result;
    }).finally(() => { loading = null; });
    return loading;
  }
  const pipeline = registerPipelineRuntime(server, store, hostDeps, () => snapshot(true), (id, prompt, requestId) => withFleetConnection(async paseo => {
    const entry = await paseo.agents.ref(id).refresh();
    if (!entry || !isQuiet(entry.agent) || entry.agent.pendingPermissions?.length || entry.agent.archivedAt) throw new Error("Coordinator changed before send.");
    await paseo.agents.ref(id).send(prompt, { messageId: requestId, activeTurnBehavior: "steer" });
  }), () => { cached = null; });
  const supervisor = createFleetSupervisor({ store, snapshot: async () => {
    const current = await snapshot(true);
    const owned = new Set(current.state.pipelines.filter(row => !["stopped", "done"].includes(row.mode)).map(row => row.remoteServerId));
    return { ...current, state: { ...current.state, queue: current.state.queue.filter(item => !owned.has(item.remoteServerId)) } };
  },
    coordinator: id => withFleetConnection(async paseo => { const entry = await paseo.agents.ref(id).refresh(); return entry ? toFleetAgent(entry.agent) : null; }),
    revalidate: (coordinator, taskId, fingerprint) => withFleetConnection(async (paseo, client, serverId) => {
      const binding = await readOrchestratorBindings(paseo, [coordinator.workspaceId], { localServerId: async () => serverId });
      if (binding.bindings[coordinator.workspaceId]?.serverId !== coordinator.remoteServerId) return false;
      const host = await readRemoteFleet(client, coordinator.remoteServerId);
      const current = { ...coordinator, links: await links.list({ serverId, agentId: coordinator.agentId, remoteServerId: coordinator.remoteServerId }) };
      const next = chooseNextTask(serverId, current, host, (await store.read()).queue);
      return Boolean(next && next.entry.task.taskId === taskId && taskFingerprint(next.entry) === fingerprint);
    }),
    send: (id, prompt, requestId) => withFleetConnection(async paseo => {
      const entry = await paseo.agents.ref(id).refresh();
      if (!entry || !isQuiet(entry.agent) || entry.agent.pendingPermissions?.length || entry.agent.archivedAt) throw new Error("Coordinator changed before send.");
      await paseo.agents.ref(id).send(prompt, { messageId: requestId, activeTurnBehavior: "steer" });
    }),
  });
  async function check() {
    if (disposed) return;
    try { await pipeline.tick(); await supervisor.tick(); heartbeat = { checkedAt: new Date().toISOString(), error: null }; }
    catch (error) { heartbeat = { checkedAt: new Date().toISOString(), error: hideSecrets(error instanceof Error ? error.message : String(error)) }; console.warn(`[mission-control] orchestrator check stopped: ${heartbeat.error}`); }
  }
  server.handle(readFleet, async ({ refresh }) => ({ ...await snapshot(refresh), heartbeat }));
  server.handle(configureSupervisor, async input => {
    const current = await snapshot(true);
    const coordinator = current.coordinators.find(item => item.agentId === input.agentId && item.remoteServerId === input.remoteServerId);
    if (!coordinator) throw new Error("The coordinator no longer belongs to this host folder.");
    if (input.enabled && current.warnings.length) throw new Error("Resolve coordinator discovery warnings before enabling automatic work.");
    const remote = current.hosts.find(item => item.serverId === input.remoteServerId);
    if (input.enabled && (!remote?.snapshot?.complete || remote.error || remote.snapshot.warnings.length)) throw new Error("A complete current fleet snapshot is required. Connect the host and update its Mission Control plugin before enabling automatic work.");
    const result = await store.update(state => {
      let entry = state.coordinators.find(item => item.agentId === input.agentId);
      if (entry?.pending && input.enabled || input.enabled && state.pipelines.some(row => row.coordinatorId === input.agentId && row.pending)) throw new Error("Reconcile the uncertain dispatch before enabling this coordinator.");
      if (!entry) { entry = supervisorEntrySchema.parse({ agentId: input.agentId, remoteServerId: input.remoteServerId }); state.coordinators.push(entry); }
      Object.assign(entry, { remoteServerId: input.remoteServerId, enabled: input.enabled, intervalMinutes: input.intervalMinutes, maxWakeupsPerDay: input.maxWakeupsPerDay, nextCheckAt: null,
        message: input.enabled ? "Enrolled. Only explicitly queued tasks can advance." : "Paused by you." });
      for (const row of state.pipelines.filter(row => row.coordinatorId === input.agentId && row.remoteServerId === input.remoteServerId)) {
        if (!input.enabled && ["running", "waiting", "ready"].includes(row.mode)) { row.mode = "paused"; row.message = "Heartbeat paused for this coordinator. Future task stages are paused too."; row.updatedAt = new Date().toISOString(); }
        else if (input.enabled && row.mode === "paused") { row.mode = "running"; row.runId = null; row.message = "Heartbeat resumed. Rechecking saved stage evidence."; row.updatedAt = new Date().toISOString(); }
      }
      if (input.enabled) state.stoppedAgentIds = state.stoppedAgentIds.filter(id => id !== input.agentId);
      fleetEvent(state, { coordinatorId: input.agentId, remoteServerId: input.remoteServerId, taskId: null, kind: "settings", message: entry.message });
    }, input.expectedRevision);
    return result;
  });
  server.handle(setFleetQueue, async input => {
    const current = await snapshot(true);
    const coordinator = current.coordinators.find(item => item.agentId === input.coordinatorId && item.remoteServerId === input.remoteServerId);
    const host = current.hosts.find(item => item.serverId === input.remoteServerId)?.snapshot;
    if (input.enabled && (!coordinator || !host || !managedTasks(current.serverId, coordinator, host).some(entry => entry.task.taskId === input.taskId))) throw new Error("This task is not linked to this coordinator. Link its worker first.");
    return store.update(state => {
      const next = { coordinatorId: input.coordinatorId, remoteServerId: input.remoteServerId, taskId: input.taskId, enabled: input.enabled, priority: input.priority, updatedAt: new Date().toISOString() };
      state.queue = state.queue.filter(item => !(item.coordinatorId === input.coordinatorId && item.remoteServerId === input.remoteServerId && item.taskId === input.taskId)); state.queue.push(next);
      fleetEvent(state, { coordinatorId: input.coordinatorId, remoteServerId: input.remoteServerId, taskId: input.taskId, kind: "settings", message: input.enabled ? `Queued for automatic work (priority ${input.priority}).` : "Removed from automatic work." });
    }, input.expectedRevision);
  });
  server.handle(pauseFleet, input => store.update(state => {
    state.paused = input.paused;
    fleetEvent(state, { coordinatorId: null, remoteServerId: null, taskId: null, kind: "settings", message: input.paused ? "All future wake-ups paused. Running turns keep their current state." : "Wake-ups resumed for enrolled coordinators and queued tasks." });
  }, input.expectedRevision));
  server.handle(acknowledgeFleetDispatch, input => store.update(state => {
    const entry = state.coordinators.find(item => item.agentId === input.agentId && item.pending?.requestId === input.requestId);
    if (!entry) throw new Error("That dispatch is no longer pending. Refresh first.");
    entry.pending = null; entry.enabled = false; entry.message = "Dispatch inspected by you. Re-enable this coordinator when ready.";
    fleetEvent(state, { coordinatorId: entry.agentId, remoteServerId: entry.remoteServerId, taskId: null, kind: "recovery", message: entry.message });
  }, input.expectedRevision));
  server.handle(reconcileFleet, async () => { await check(); if (heartbeat.error) throw new Error(heartbeat.error); return store.read(); });
  server.on("agent.turn_ended", async event => {
    if (disposed) return;
    if (event.outcome.kind === "canceled") await store.update(state => {
      state.stoppedAgentIds = [...new Set([...state.stoppedAgentIds, event.agent.id])].slice(-2000);
      for (const row of state.pipelines.filter(item => item.coordinatorId === event.agent.id && !["done", "stopped"].includes(item.mode))) { row.mode = "paused"; row.message = "You stopped this coordinator. Future runner stages are paused."; row.updatedAt = new Date().toISOString(); }
      const entry = state.coordinators.find(entry => entry.agentId === event.agent.id);
      if (entry) { entry.enabled = false; entry.message = "You stopped this coordinator. Automatic wake-ups are paused.";
        fleetEvent(state, { coordinatorId: entry.agentId, remoteServerId: entry.remoteServerId, taskId: null, kind: "blocked", message: entry.message }); }
    });
    cached = null;
  });
  server.on("agent.turn_started", async event => {
    if (disposed) return;
    if ((await store.read()).stoppedAgentIds.includes(event.agent.id)) await store.update(state => { state.stoppedAgentIds = state.stoppedAgentIds.filter(id => id !== event.agent.id); });
    cached = null;
  });
  const timer = setInterval(() => void check(), 30_000); timer.unref?.();
  return () => { disposed = true; clearInterval(timer); pipeline.stop(); supervisor.stop(); cached = null; };
}
