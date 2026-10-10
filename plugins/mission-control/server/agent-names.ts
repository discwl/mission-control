import type { PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { renameConflict } from "../shared/naming";
import { agentDisplayName } from "../shared/agent-names";

type RenameInput = { serverId: string; agentId: string; expected: string; name: string };
export type AgentRenameDeps = {
  localServerId(): Promise<string>;
  setAgentName(agentId: string, name: string): Promise<void>;
};

type DaemonSources = { home?: string; env?: NodeJS.ProcessEnv; argv?: string[] };
const paseoHome = () => process.env.PASEO_HOME || join(homedir(), ".paseo");
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;

/** What the running daemon records in paseo.pid once its worker is ready: its bound listen address and server ID. */
async function daemonLock(home: string): Promise<{ listen: string | null; serverId: string | null }> {
  try {
    const lock = JSON.parse(await readFile(join(home, "paseo.pid"), "utf8"));
    return { listen: text(lock?.listen), serverId: text(lock?.serverId) };
  } catch { return { listen: null, serverId: null }; }
}

function listenArgument(argv: string[]) {
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--listen") return text(argv[index + 1]);
    if (argv[index].startsWith("--listen=")) return text(argv[index].slice("--listen=".length));
  }
  return null;
}

/** Where the daemon listens: what it recorded, else Paseo's own order of --listen, PASEO_LISTEN, daemon.listen, then PORT. */
export async function daemonListen({ home = paseoHome(), env = process.env, argv = process.argv }: DaemonSources = {}): Promise<string> {
  const recorded = (await daemonLock(home)).listen ?? listenArgument(argv) ?? text(env.PASEO_LISTEN);
  if (recorded) return recorded;
  try {
    const configured = text(JSON.parse(await readFile(join(home, "config.json"), "utf8"))?.daemon?.listen);
    if (configured) return configured;
  } catch {
    // No readable config: Paseo's default.
  }
  return `127.0.0.1:${text(env.PORT) ?? 6767}`;
}

/** A WebSocket URL for a Paseo listen string, read the way Paseo's daemon reads it. */
export function listenUrl(listen: string): string {
  const value = listen.trim();
  if (/^(\\\\\.\\pipe\\|pipe:\/\/|unix:\/\/|\/|~)/.test(value)) {
    throw new Error(`Paseo's daemon listens on a pipe or socket (${value}), and Mission Control can rename agents only over TCP. Set Paseo's listen address to a host and port, such as 127.0.0.1:6767.`);
  }
  // A bare port is TCP on loopback.
  if (/^\d+$/.test(value)) return `ws://127.0.0.1:${value}/ws`;
  const at = value.lastIndexOf(":");
  const port = at < 0 ? NaN : Number.parseInt(value.slice(at + 1), 10);
  if (!Number.isFinite(port)) throw new Error(`Mission Control can't read Paseo's listen address "${value}".`);
  let host = value.slice(0, at);
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  // A wildcard bind address is not dialable; loopback reaches the same daemon.
  if (!host || host === "0.0.0.0" || host === "::") host = "127.0.0.1";
  return `ws://${host.includes(":") ? `[${host}]` : host}:${port}/ws`;
}

/** The local daemon's WebSocket URL. */
export async function daemonWsUrl(sources: DaemonSources = {}): Promise<string> {
  return listenUrl(await daemonListen(sources));
}

/** This host's Paseo server ID, from the daemon itself rather than a dev-vault host profile. */
export async function daemonServerId(home = paseoHome()): Promise<string> {
  const recorded = (await daemonLock(home)).serverId;
  if (recorded) return recorded;
  try {
    const saved = text(await readFile(join(home, "server-id"), "utf8"));
    if (saved) return saved;
  } catch {
    // Reported below.
  }
  throw new Error("Mission Control couldn't find this host's Paseo server ID, so it can't rename agents here. Check that Paseo is running on this host, then try again.");
}

/**
 * INTERNAL PASEO API: PaseoApi 0.9.1 has no agent rename, so this opens a short-lived
 * DaemonClient against the local daemon and calls updateAgent (the call behind MCP
 * update_agent). It may break when Paseo changes @getpaseo/client/internal/daemon-client.
 */
export async function setAgentNameViaDaemon(agentId: string, name: string): Promise<void> {
  const client = new DaemonClient({
    url: await daemonWsUrl(),
    clientId: `plugin-mission-control-${process.pid}`,
    clientType: "cli",
    connectTimeoutMs: 5_000,
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
    await client.updateAgent(agentId, { name });
  } finally {
    await client.close();
  }
}

export async function renameAgentRecord(input: RenameInput, paseo: PaseoApi, deps: AgentRenameDeps): Promise<{ title: string }> {
  // The DaemonClient reaches this host's daemon only.
  if (input.serverId !== await deps.localServerId()) throw new Error("Agents can only be renamed on the host running this Mission Control.");
  const agent = paseo.agents.ref(input.agentId);
  const before = await agent.refresh();
  if (!before || before.agent.archivedAt) throw new Error("This agent is no longer available.");
  const conflict = renameConflict(input.expected, agentDisplayName(before.agent));
  if (conflict) throw new Error(conflict);
  await deps.setAgentName(input.agentId, input.name);
  const after = await agent.refresh();
  return { title: after ? agentDisplayName(after.agent) : input.name };
}
