import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { createPaseoApi } from "@getpaseo/client";
import { createHostClient } from "@getpaseo/client/node";

/** Read the owning daemon at the point evidence is recorded, not the agent's self-reported model. */
export async function verifyNativeStageAgent(assignment) {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const lock = JSON.parse(await readFile(join(home, "paseo.pid"), "utf8"));
  if (lock.serverId !== assignment.serverId || typeof lock.listen !== "string") throw new Error("Cannot verify stage identity against this host's running Paseo daemon.");
  let listen = lock.listen.replace(/^0\.0\.0\.0:/, "127.0.0.1:").replace(/^\[::\]:/, "127.0.0.1:");
  const client = createHostClient(listen, { clientType: "cli", clientId: `mc-stage-evidence-${randomUUID()}`, reconnect: { enabled: false }, connectTimeoutMs: 5000 });
  const paseo = createPaseoApi(client);
  try {
    await client.connect();
    if (client.getLastServerInfoMessage()?.serverId !== assignment.serverId) throw new Error("Stage identity connected to a different host.");
    const agent = (await paseo.agents.ref(assignment.agentId).refresh())?.agent;
    if (!agent || agent.workspaceId !== assignment.workspaceId || agent.provider !== assignment.execution.provider || agent.model !== assignment.execution.model) throw new Error("The agent's actual provider/model does not match its stage assignment. Start a fresh stage with the configured profile.");
    return { provider: agent.provider, model: agent.model, verifiedAt: new Date().toISOString() };
  } finally { paseo.dispose(); await client.close(); }
}
