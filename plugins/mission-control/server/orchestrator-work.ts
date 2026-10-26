import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listOrchestratorWork, setOrchestratorWork, orchestratorWorkSchema, sameOwner, type OrchestratorOwner, type OrchestratorWork } from "../shared/orchestrator-work";
import { daemonServerId } from "./agent-names";
import { readOrchestratorBindings } from "./orchestrator";

export function createOrchestratorWorkStore(file = join(process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo"), "plugin-data", "mission-control", "orchestrator-work.json")) {
  let chain: Promise<unknown> = Promise.resolve();
  async function load(): Promise<OrchestratorWork[]> {
    try { return orchestratorWorkSchema.array().parse(JSON.parse(await readFile(file, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  return {
    async list(owner: OrchestratorOwner) { await chain; return (await load()).filter(link => sameOwner(link, owner)); },
    set(input: Omit<OrchestratorWork, "linkedAt"> & { linked: boolean }): Promise<OrchestratorWork[]> {
      const run = async () => {
        const links = (await load()).filter(link => !(sameOwner(link, input) && link.remoteAgentId === input.remoteAgentId));
        if (input.linked) links.push(orchestratorWorkSchema.parse({ ...input, linkedAt: new Date().toISOString() }));
        await mkdir(dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(links, null, 2)}\n`, "utf8");
        await rename(temporary, file);
        return links.filter(link => sameOwner(link, input));
      };
      const result = chain.then(run, run);
      chain = result.catch(() => {});
      return result;
    },
  };
}

export function registerOrchestratorWork(server: PluginServerContext) {
  const store = createOrchestratorWorkStore();
  // Never silently record against the CLI default daemon or another chat's host folder.
  async function validate(owner: OrchestratorOwner, paseo: Parameters<typeof readOrchestratorBindings>[0] & Pick<import("@getpaseo/client").PaseoApi, "agents">) {
    if (owner.serverId !== await daemonServerId()) throw new Error("The orchestrator belongs to another host.");
    const agent = (await paseo.agents.ref(owner.agentId).refresh())?.agent;
    if (!agent?.workspaceId || agent.archivedAt) throw new Error("The orchestrator chat is unavailable.");
    const result = await readOrchestratorBindings(paseo, [agent.workspaceId], { localServerId: () => daemonServerId() });
    if (result.bindings[agent.workspaceId]?.serverId !== owner.remoteServerId) throw new Error("This chat's host.json does not match the worker's host.");
  }
  server.handle(listOrchestratorWork, async (input, { paseo }) => {
    await validate(input, paseo);
    return { links: await store.list(input) };
  });
  server.handle(setOrchestratorWork, async (input, { paseo }) => {
    await validate(input, paseo);
    return { links: await store.set(input) };
  });
}
