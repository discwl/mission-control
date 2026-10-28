#!/usr/bin/env node
// Drives another host's Mission Control through this machine's saved Paseo destination: import tickets as
// tasks, start and resume them through Mission Control's launcher, and read their status and evidence. It's for
// orchestrator agents, so ticket work follows the Development Flow instead of starting plain agents.
//
// Approving or rejecting review decisions, merging and opening pull requests stay with the user in Mission Control.
//
//   node remote.mjs --server <serverId> <command> [options]   (the saved destination; no pairing file)
//   node remote.mjs --offer-file <file> <command> [options]    (explicit legacy/admin connection)
//   node remote.mjs --local <command> [options]                  (this machine's daemon)
//
// Output is JSON on stdout; a failure prints its message on stderr and exits 1.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const PLUGIN_ID = "mission-control";

export const usage = `Usage: remote.mjs (--server <serverId> | --local | --offer-file <file>) <command> [options]

Connections:
  --server <serverId>                        Use this machine's saved Paseo destination (no pairing file).
  --local                                    Use this machine's Mission Control.
  --offer-file <file>                         Explicit legacy/admin connection only; never regenerate as a fallback.
                                             Discover destinations with Paseo list_hosts. Never register Personal remotely.

Commands:
  identity                                   The host's Paseo server ID.
  summary                                    Task counts per workspace and project.
  tasks --workspace <id>                     The workspace's tasks.
  import-ticket --workspace <id> --system <jira|azure-devops> --key <key> --url <url> --title <title>
      [--type <type>] [--description-file <file>] [--criteria-file <file>] [--status <text>] [--sprint <text>]
                                             Imports one ticket as a task; an already imported ticket returns its tasks.
  create --workspace <id> --title <title> --criteria-file <file>
                                             A task without a ticket.
  status --workspace <id> --task <id>        What Start would do, the agent, the latest run and its stage.
  start --workspace <id> --task <id> [--provider <provider/model>] [--thinking <id>] [--mode <id>]
      [--no-isolate] [--branch <name>] [--branch-type <feature|bugfix>] [--orchestrator-agent <local chat id>]
                                             Links the worker to PASEO_AGENT_ID (or --orchestrator-agent) on this machine.
                                             Starts, resumes or recovers the task's agent, as the Start button does.
  set-status --workspace <id> --task <id> --to <inbox|ready|in_progress|blocked|in_review|delivered|closed>
  due --workspace <id> --task <id> (--date <YYYY-MM-DD> | --clear)
  runs --workspace <id> --task <id>          The task's run records (stage, outcome, next action).
  docs --workspace <id> --task <id> [--name <file>]
                                             The task's documents, or one document's text (e.g. handoff.md).
  attention                                  Open decisions and questions waiting for the user.
  morning-status                             The latest Morning check report and what it hasn't imported.
  morning-start --workspace <id> --provider <provider/model> [--thinking <id>] [--mode <id>]
  morning-import --workspace <id> --report <reportId> --item <system:KEY> [--item ...]`;

const options = {
  server: { type: "string" }, "offer-file": { type: "string" }, local: { type: "boolean" }, help: { type: "boolean", short: "h" },
  workspace: { type: "string" }, task: { type: "string" },
  system: { type: "string" }, key: { type: "string" }, url: { type: "string" }, title: { type: "string" }, type: { type: "string" },
  "description-file": { type: "string" }, "criteria-file": { type: "string" }, status: { type: "string" }, sprint: { type: "string" },
  provider: { type: "string" }, thinking: { type: "string" }, mode: { type: "string" },
  "no-isolate": { type: "boolean" }, branch: { type: "string" }, "branch-type": { type: "string" },
  to: { type: "string" }, date: { type: "string" }, clear: { type: "boolean" }, name: { type: "string" },
  report: { type: "string" }, item: { type: "string", multiple: true },
  "orchestrator-agent": { type: "string" },
};

const need = (values, ...names) => {
  const missing = names.filter(name => values[name] === undefined || values[name] === "");
  if (missing.length) throw new Error(`Missing ${missing.map(name => `--${name}`).join(", ")}.`);
};
const text = async file => file ? (await readFile(file, "utf8")).trim() : "";

/** What `status` and `start` report: the decision, not the whole launch record. */
export function describeLaunch(status) {
  return {
    action: status.action,
    message: status.message,
    agent: status.agent,
    run: status.run ? { runId: status.run.runId, stage: status.run.stage, outcome: status.run.outcome, nextAction: status.run.nextAction, updatedAt: status.run.updatedAt } : null,
    worktree: status.worktree,
    launchError: status.launch?.error ?? null,
  };
}

/** The dispatch input for a launch status, the way Mission Control's Start button builds it. */
export function launchInput(binding, status, values) {
  const input = { ...binding, expectedRevision: status.revision };
  if (status.action !== "start") return input;
  if (values.provider) input.provider = values.provider;
  if (values.thinking) input.thinkingOptionId = values.thinking;
  if (values.mode) input.modeId = values.mode;
  if (!status.canIsolate) return input;
  input.isolate = !values["no-isolate"];
  if (!input.isolate) return input;
  if (values.branch) { input.branch = values.branch; if (values["branch-type"]) input.branchType = values["branch-type"]; return input; }
  const preview = status.branch;
  if (!preview) return input;
  const option = preview.options.length > 1 ? preview.options.find(entry => entry.type === (values["branch-type"] ?? "feature")) : preview.options[0];
  const problem = preview.problem ?? option?.problem ?? (option ? null : "The task's branch name is unknown.");
  if (problem) throw new Error(`Can't start in a worktree: ${problem} Pass --branch <name>, or --no-isolate.`);
  input.branch = option.name;
  if (preview.options.length > 1 && option.type) input.branchType = option.type;
  return input;
}

/** Runs one command. `rpc(method, input)` calls the host's Mission Control. */
export async function runCommand(command, values, rpc) {
  const { serverId } = await rpc("host.identity", {});
  const workspace = () => { need(values, "workspace"); return { serverId, workspaceId: values.workspace }; };
  const binding = () => { need(values, "workspace", "task"); return { serverId, workspaceId: values.workspace, taskId: values.task }; };
  const task = async () => {
    const { tasks } = await rpc("tasks.list", workspace());
    const found = tasks.find(entry => entry.taskId === values.task);
    if (!found) throw new Error(`Task ${values.task} isn't assigned to workspace ${values.workspace}.`);
    return found;
  };
  switch (command) {
    case "identity": return { serverId };
    case "summary": return rpc("tasks.summary", { serverId });
    case "tasks": {
      const { tasks, problems } = await rpc("tasks.list", workspace());
      return { tasks: tasks.map(entry => ({ taskId: entry.taskId, title: entry.title, status: entry.status, ticket: entry.ticket?.key ?? null, dueDate: entry.dueDate ?? null, worktree: entry.worktree?.workspaceId ?? null, pullRequest: entry.pullRequest?.url ?? null })), problems };
    }
    case "import-ticket": {
      need(values, "workspace", "system", "key", "url", "title");
      const item = {
        system: values.system, key: values.key, url: values.url, title: values.title, ...(values.type ? { type: values.type } : {}),
        description: await text(values["description-file"]), acceptanceCriteria: await text(values["criteria-file"]),
        status: values.status ?? "", sprint: values.sprint ?? "",
      };
      return rpc("tasks.import-ticket", { ...workspace(), item });
    }
    case "create": {
      need(values, "title", "criteria-file");
      const created = await rpc("tasks.create", { ...workspace(), title: values.title, acceptanceCriteria: await text(values["criteria-file"]) });
      return { taskId: created.taskId, title: created.title, status: created.status };
    }
    case "status": return describeLaunch(await rpc("tasks.launch.status", binding()));
    case "start": {
      const target = binding();
      const status = await rpc("tasks.launch.status", target);
      if (!["start", "resume", "recover"].includes(status.action)) return { started: false, ...describeLaunch(status) };
      const input = launchInput(target, status, values);
      let nativeParent = { linked: false, reason: status.action === "start" ? "Originating chat or native host connection is unavailable." : "Existing workers keep their original parent." };
      if (status.action === "start" && values.parent) {
        try {
          const check = await rpc("tasks.launch.parent", values.parent);
          if (check.supported) { input.parent = values.parent; nativeParent = { linked: true }; }
          else nativeParent.reason = check.reason || "Native parent connection is unavailable.";
        } catch { nativeParent.reason = "This host does not support native Mission Control worker parents yet. Update Mission Control and Paseo on both hosts."; }
      }
      // Never retry a dispatch whose response is lost. Status reconciles its existing launch receipt.
      const next = await rpc("tasks.launch.dispatch", input);
      return { started: true, ...describeLaunch(next), ...(values.parent ? { nativeParent: { ...nativeParent, linked: Boolean(next.launch?.parent), requested: Boolean(input.parent) } } : {}) };
    }
    case "set-status": {
      need(values, "to");
      const current = await task();
      const updated = await rpc("tasks.status.update", { ...binding(), status: values.to, expectedUpdatedAt: current.updatedAt });
      return { taskId: updated.taskId, status: updated.status };
    }
    case "due": {
      if (!values.clear) need(values, "date");
      const current = await task();
      const updated = await rpc("tasks.due.update", { ...binding(), dueDate: values.clear ? null : values.date, expectedUpdatedAt: current.updatedAt });
      return { taskId: updated.taskId, dueDate: updated.dueDate ?? null };
    }
    case "runs": return rpc("tasks.runs.list", binding());
    case "docs": {
      const { documents } = await rpc("tasks.documents.list", binding());
      if (!values.name) return { documents: documents.map(entry => ({ name: entry.name, updatedAt: entry.updatedAt })) };
      const found = documents.find(entry => entry.name === values.name);
      if (!found) throw new Error(`${values.name} isn't one of the task's documents: ${documents.map(entry => entry.name).join(", ") || "none"}.`);
      return { name: found.name, updatedAt: found.updatedAt, content: found.content };
    }
    case "attention": {
      const [decisions, waiting] = await Promise.all([rpc("decisions.list", { serverId }), rpc("attention.waiting", { serverId })]);
      return { decisions: decisions.open, questions: waiting.questions };
    }
    case "morning-status": return rpc("morning.status", { serverId });
    case "morning-start": {
      need(values, "provider");
      return rpc("morning.start", { ...workspace(), provider: values.provider, ...(values.thinking ? { thinkingOptionId: values.thinking } : {}), ...(values.mode ? { modeId: values.mode } : {}), fixture: false });
    }
    case "morning-import": {
      need(values, "report", "item");
      return rpc("morning.import", { ...workspace(), reportId: values.report, items: values.item });
    }
    default: throw new Error(`Unknown command "${command}".\n\n${usage}`);
  }
}

/** A link failure must never turn a successful remote dispatch into an apparently failed start. */
export async function recordStartedWork(result, target, record) {
  if (!result.agent?.id) return { linked: false, warning: "No worker was returned. Use Link workers in Review after the launch completes." };
  try {
    await record({ remoteServerId: target.serverId, remoteAgentId: result.agent.id,
      remoteWorkspaceId: result.worktree?.workspaceId || target.workspaceId, taskId: target.taskId, linked: true });
    return { linked: true };
  } catch (error) {
    return { linked: false, warning: `Remote start result is unchanged; its chat link could not be saved: ${error instanceof Error ? error.message : String(error)}. Use Link workers in Review; do not repeat Start just to save the link.` };
  }
}

async function localUrl() {
  const home = process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  let listen = "127.0.0.1:6767";
  try { listen = JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")).listen || listen; } catch { /* Paseo's default */ }
  if (/^\d+$/.test(listen)) listen = `127.0.0.1:${listen}`;
  return `ws://${listen.replace(/^(0\.0\.0\.0|\[::\]):/, "127.0.0.1:")}/ws`;
}

// The daemon drops an earlier connection that reuses a client ID, so each connection gets its own. Sharing one cut
// the --server route when start opened its parent connection ("host.identity: Transport not connected").
let connectionCount = 0;

/**
 * INTERNAL PASEO API: PaseoApi has no plugin RPC call, so this uses @getpaseo/client's internal DaemonClient, as the
 * plugin's agent rename does. It may break when Paseo changes that client.
 */
async function connect(values) {
  const selectors = [Boolean(values.local), values.server !== undefined, values["offer-file"] !== undefined].filter(Boolean);
  if (selectors.length !== 1) throw new Error(`Choose exactly one connection: --server <serverId>, --local, or --offer-file <file>.\n\n${usage}`);
  if (values.server !== undefined && !values.server.trim()) throw new Error("--server requires a non-empty destination server ID from list_hosts.");
  const { DaemonClient } = await import("@getpaseo/client/internal/daemon-client");
  const base = { clientId: `mission-control-remote-${process.pid}-${++connectionCount}`, clientType: "cli", connectTimeoutMs: 30_000, reconnect: { enabled: false } };
  if (values.server !== undefined) {
    const { createHostChannelTransport } = await import("@getpaseo/client/node");
    const origin = await connect({ local: true });
    return connectRegisteredHost(values.server.trim(), origin, serverId => new DaemonClient({
      ...base,
      transportFactory: createHostChannelTransport(origin, serverId, `mission-control-${process.pid}-${Date.now()}`, null),
    }));
  }
  let client;
  if (values.local) client = new DaemonClient({ ...base, url: await localUrl() });
  else {
    if (!values["offer-file"]?.trim()) throw new Error("--offer-file requires a file path for an explicit legacy/admin connection. Prefer --server <serverId> for orchestration.");
    const [{ parseConnectionOfferFromUrl }, { buildRelayWebSocketUrl, shouldUseTlsForDefaultHostedRelay }, { default: WebSocket }] = await Promise.all([
      import("@getpaseo/protocol/connection-offer"), import("@getpaseo/protocol/daemon-endpoints"), import("ws"),
    ]);
    const offer = parseConnectionOfferFromUrl((await readFile(values["offer-file"], "utf8")).trim());
    if (!offer) throw new Error(`${values["offer-file"]} doesn't hold a Paseo pairing URL.`);
    client = new DaemonClient({
      ...base,
      url: buildRelayWebSocketUrl({ endpoint: offer.relay.endpoint, serverId: offer.serverId, role: "client", useTls: offer.relay.useTls ?? shouldUseTlsForDefaultHostedRelay(offer.relay.endpoint) }),
      e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 },
      webSocketFactory: (target, config) => new WebSocket(target, config?.protocols, { headers: config?.headers }),
    });
  }
  try { await client.connect(); } catch (error) {
    await client.close().catch(() => {});
    throw new Error(`Couldn't reach the host's Paseo: ${error instanceof Error ? error.message : error}`);
  }
  return client;
}

/** Route through an existing local registration; never pair, re-register, or fall back to the local host. */
export async function connectRegisteredHost(serverId, origin, createClient) {
  let client, closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await client?.close(); } finally { await origin.close(); }
  };
  try {
    const directory = await origin.listHosts();
    const host = directory.hosts.find(entry => entry.serverId === serverId);
    if (!host) throw new Error(`Destination ${serverId} is not registered on this machine. Check list_hosts and this orchestrator folder's host.json; do not recreate pairing files or register Personal remotely.`);
    if (!host.enabled || host.status !== "online") throw new Error(`Destination ${host.label || serverId} (${serverId}) is ${!host.enabled ? "disabled" : host.status}. Check list_hosts and the remote machine's Paseo/network; do not regenerate pairing files or change registrations.`);
    client = await createClient(serverId);
    await client.connect();
    const identity = await client.invokePluginRpc(PLUGIN_ID, "host.identity", {});
    if (identity.serverId !== serverId) throw new Error(`Host identity mismatch: requested ${serverId}, received ${identity.serverId}. No task command was sent.`);
    return { invokePluginRpc: (...args) => client.invokePluginRpc(...args), close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

async function main() {
  const { values, positionals } = parseArgs({ options, allowPositionals: true });
  if (values.help || !positionals.length) { console.log(usage); return; }
  const client = await connect(values);
  let parentClient, parentAddress;
  const originAgentId = values["orchestrator-agent"]?.trim() || process.env.PASEO_AGENT_ID?.trim();
  try {
    if (positionals[0] === "start" && originAgentId) {
      try {
        parentClient = await connect({ local: true });
        const { serverId } = await parentClient.invokePluginRpc(PLUGIN_ID, "host.identity", {});
        parentAddress = { serverId, agentId: originAgentId };
      } catch { /* Task launch still works without native parent routing. */ }
    }
    let remoteServerId;
    const result = await runCommand(positionals[0], values, async (method, input) => {
      try {
        const response = await client.invokePluginRpc(PLUGIN_ID, method, input);
        if (method === "host.identity") {
          remoteServerId = response.serverId;
          if (parentClient && parentAddress) {
            try {
              // This also validates that the exact originating chat's host.json targets this host.
              await parentClient.invokePluginRpc(PLUGIN_ID, "orchestrator.work.list", { ...parentAddress, remoteServerId });
              values.parent = parentAddress;
            } catch { /* Do not infer ownership from a folder or a matching title. */ }
          }
        }
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(/unknown|not found|no handler/i.test(message) ? `${method}: ${message} (is Mission Control installed and up to date on that host?)` : `${method}: ${message}`);
      }
    });
    if (positionals[0] === "start") {
      const agentId = values["orchestrator-agent"]?.trim() || process.env.PASEO_AGENT_ID?.trim();
      if (!agentId) result.orchestrator = { linked: false, warning: "No originating chat identity. Use --orchestrator-agent or Link workers in Review." };
      else {
        let origin;
        result.orchestrator = await recordStartedWork(result, {
          serverId: remoteServerId,
          workspaceId: values.workspace, taskId: values.task,
        }, async link => {
          origin = await connect({ local: true });
          const { serverId } = await origin.invokePluginRpc(PLUGIN_ID, "host.identity", {});
          await origin.invokePluginRpc(PLUGIN_ID, "orchestrator.work.set", { ...link, serverId, agentId });
        });
        await origin?.close().catch(() => {});
      }
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await parentClient?.close().catch(() => {});
    await client.close().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
