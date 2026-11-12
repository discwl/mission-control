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

type DaemonSources = { home?: string; env?: NodeJS.ProcessEnv; argv?: string[]; alive?: (pid: number) => boolean };
const paseoHome = () => process.env.PASEO_HOME || join(homedir(), ".paseo");
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;

/**
 * Paseo's daemon loads every plugin before it accepts other connections. Until then it answers them with HTTP 503, which
 * reaches Mission Control's own daemon connections as "Transport closed (code 1006)".
 */
export class PaseoStartingError extends Error {
  constructor() {
    super("Paseo is still starting (its daemon accepts connections once every plugin has loaded).");
    this.name = "PaseoStartingError";
  }
}

/** Whether a process exists. EPERM means it exists but this process may not signal it. */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * paseo.pid, held by Paseo's supervisor while it runs. The supervisor adds its worker's bound listen address and server
 * ID once the worker accepts connections, and clears them when the worker exits.
 */
async function daemonLock(home: string): Promise<{ pid: number | null; listen: string | null; serverId: string | null }> {
  try {
    const lock = JSON.parse(await readFile(join(home, "paseo.pid"), "utf8"));
    return { pid: Number.isInteger(lock?.pid) && lock.pid > 0 ? lock.pid : null, listen: text(lock?.listen), serverId: text(lock?.serverId) };
  } catch { return { pid: null, listen: null, serverId: null }; }
}

function listenArgument(argv: string[]) {
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--listen") return text(argv[index + 1]);
    if (argv[index].startsWith("--listen=")) return text(argv[index].slice("--listen=".length));
  }
  return null;
}

/**
 * Where the daemon listens: what it recorded, else Paseo's own order of --listen, PASEO_LISTEN, daemon.listen, then PORT.
 * While a running supervisor hasn't recorded an address, the daemon is still starting and refuses connections, so this
 * throws PaseoStartingError instead of guessing one. A lock whose supervisor is gone is stale and doesn't count.
 */
export async function daemonListen({ home = paseoHome(), env = process.env, argv = process.argv, alive = processAlive }: DaemonSources = {}): Promise<string> {
  const lock = await daemonLock(home);
  if (lock.pid !== null && !lock.listen && alive(lock.pid)) throw new PaseoStartingError();
  const recorded = lock.listen ?? listenArgument(argv) ?? text(env.PASEO_LISTEN);
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

/** The local daemon's WebSocket URL, once the daemon accepts connections. */
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
 * INTERNAL PASEO API: PaseoApi has no agent rename (still true in 0.12), so this opens a short-lived
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
