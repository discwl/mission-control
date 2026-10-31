import { createHash } from "node:crypto";
import { createPaseoApi } from "@getpaseo/client";
import { readFleetHost } from "../shared/fleet";
import { getMorningStatus, startMorningCheck, importMorningItems } from "../shared/morning";
import { captureIntake, routeIntake } from "../shared/intake";
import { ticketIdentity } from "../shared/tickets";
import { invokeChatHost, withChatHost } from "./chat-transport";

export const INTAKE_CHAT_HELP = "discover [workspace] [using provider] — run read-only Discovery; asks when a destination is ambiguous\ndiscovery — latest report and agent status\ndiscovery workspaces — list destinations\ndiscovery import KEY[,KEY] into <workspace> — save selected tickets to backlog\nsave task in <workspace> | <title> | <requirements> — describe a task\nqueue task in <workspace> | <title> | <requirements> — capture and queue planning\nplan task in <workspace> | <title> | <requirements> — capture and request planning\nplan task <task ID> — request planning for a saved intake task";
type Context = { local: string; target: string; agentId: string; label: string; orchestrator: boolean };

export async function manageIntakeChat(command: string, context: Context): Promise<{ text: string } | null> {
  if (!/^(?:discover\b|discovery\b|(?:save|queue|plan) task\b)/i.test(command)) return null;
  if (!context.orchestrator) return { text: "Use Discovery and intake in the host's coordinator chat, so the destination is explicit. You can also use Kanban → Intake." };
  const host = readFleetHost.output.parse(await invokeChatHost(context.target, readFleetHost.name, { serverId: context.target }));
  if (host.serverId !== context.target || !host.complete || host.warnings.length) throw new Error("Refresh this host's incomplete records before starting Discovery or intake.");
  const workspaces = host.workspaces.filter(w => !["archived", "archiving", "failed"].includes(w.status));
  const list = () => workspaces.map(w => `${w.id} — ${w.projectName} / ${w.name}`).join("\n");
  const select = (query?: string) => {
    if (!query) return workspaces.length === 1 ? workspaces[0] : undefined;
    const matches = workspaces.filter(w => w.id === query || w.name.toLowerCase() === query.toLowerCase() || `${w.projectName} / ${w.name}`.toLowerCase() === query.toLowerCase());
    return matches.length === 1 ? matches[0] : undefined;
  };
  if (/^discovery workspaces$/i.test(command)) return { text: `${context.label} · Discovery destinations\n${list() || "No available workspaces."}` };
  const saved = /^plan task\s+(task_[a-f0-9-]+)$/i.exec(command);
  if (saved) {
    const result = routeIntake.output.parse(await invokeChatHost(context.local, routeIntake.name, { coordinatorId: context.agentId, remoteServerId: context.target, taskId: saved[1], action: "plan" }));
    return { text: `${context.label} · ${result.title}\n${result.message}\n${result.taskId}` };
  }
  const task = /^(save|queue|plan) task in (.+?)\s*\|\s*([^|]+)\|\s*([\s\S]+)$/i.exec(command);
  if (task) {
    const workspace = select(task[2].trim());
    if (!workspace) return { text: `Choose one exact workspace on ${context.label}; nothing was created.\n${list()}\n${INTAKE_CHAT_HELP}` };
    const title = task[3].trim(), acceptanceCriteria = task[4].trim();
    const hash = createHash("sha256").update(JSON.stringify([context.local, context.agentId, context.target, workspace.id, title, acceptanceCriteria])).digest("hex");
    const requestId = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
    const input = captureIntake.input.parse({ coordinatorId: context.agentId, remoteServerId: context.target, workspaceId: workspace.id, requestId, title, acceptanceCriteria, action: task[1].toLowerCase() === "save" ? "backlog" : task[1].toLowerCase() });
    const result = captureIntake.output.parse(await invokeChatHost(context.local, captureIntake.name, input));
    return { text: `${context.label} · ${workspace.projectName} / ${workspace.name}\n${result.title}\n${result.message}\n${result.taskId}\nRepeating these same task details reuses this intake. Plan approval and publishing permission are unchanged.` };
  }
  const status = getMorningStatus.output.parse(await invokeChatHost(context.target, getMorningStatus.name, { serverId: context.target }));
  if (/^discovery(?: status)?$/i.test(command)) return { text: `${context.label} · Discovery\n${status.agent?.busy ? "Agent running; report not yet complete." : status.launch?.phase === "sending" ? "Launch unconfirmed; inspect the existing agent before another start." : "No discovery agent currently running."}\n${status.report ? `Report ${status.report.reportId} · ${status.report.createdAt}\n${status.missing.map(item => `${item.key} — ${item.title}`).join("\n") || "No new tickets in this report."}\n${status.imported.length} tickets already tracked.` : "No saved report yet. Use discover to start."}${status.reportError ? `\nReport error: ${status.reportError}` : ""}\nOpen Kanban → Intake → Discover work to inspect and import selected tickets.` };
  const importing = /^discovery import (.+?) into (.+)$/i.exec(command);
  if (importing) {
    const workspace = select(importing[2].trim());
    if (!workspace || !status.report || status.reportError) return { text: `A readable report and exact destination are required. Nothing imported.\n${list()}` };
    const keys = importing[1].split(",").map(key => key.trim().toLowerCase()).filter(Boolean);
    const items: string[] = [];
    for (const key of keys) {
      const matches = status.report.items.filter(item => item.key.toLowerCase() === key || ticketIdentity(item).toLowerCase() === key);
      if (matches.length !== 1) return { text: `Ticket '${key}' is missing or ambiguous in this report. Use its exact system:key identity. Nothing imported.` };
      items.push(ticketIdentity(matches[0]));
    }
    const result = importMorningItems.output.parse(await invokeChatHost(context.target, importMorningItems.name, { serverId: context.target, workspaceId: workspace.id, reportId: status.report.reportId, items }));
    return { text: `${context.label} · ${workspace.projectName} / ${workspace.name}\nSaved ${result.created.length} tasks to backlog; ${result.skipped.length} already tracked. No workers launched.\n${result.created.map(t => `${t.key}: ${t.taskId}`).join("\n")}\nUse plan task <task ID> or queue <task ID> priority 5 when ready.` };
  }
  const discover = /^discover(?:\s+(?!using\b)(.+?))?(?:\s+using\s+(\S+))?$/i.exec(command);
  if (!discover) return { text: INTAKE_CHAT_HELP };
  if (status.agent?.busy || status.launch?.phase === "sending" && !status.agent) return { text: `${context.label} · Discovery ${status.agent?.busy ? "is already running" : "launch is unconfirmed"}. Inspect the existing agent ${status.agent?.id ?? status.launch?.agentId}; no second agent was started.` };
  const workspace = select(discover[1]?.trim()) ?? (!discover[1] ? workspaces.find(w => w.id === status.launch?.workspaceId) : undefined);
  if (!workspace) return { text: `Choose where Discovery should run on ${context.label}:\n${list()}\nReply: discover <workspace ID> using <provider>\nDiscovery reads tracker items; it does not import or start tasks.` };
  const chosen = await withChatHost(context.target, async client => {
    const api = createPaseoApi(client);
    try {
      const available = (await api.providers.listAvailable()).providers.filter(p => p.available);
      const previous = status.launch?.workspaceId === workspace.id ? status.launch.provider : undefined;
      const requested = discover[2] ?? previous;
      const provider = requested ? available.find(p => p.provider === requested.split("/")[0]) : available.length === 1 ? available[0] : undefined;
      if (!provider) return { error: `Choose a provider: ${available.map(p => p.provider).join(", ") || "none available"}. Reply: discover ${workspace.id} using <provider>` };
      const models = (await api.providers.listModels(provider.provider)).models ?? [];
      const modelId = requested?.includes("/") ? requested.slice(requested.indexOf("/") + 1) : undefined;
      const model = modelId ? models.find(m => m.id === modelId) : models.find(m => m.isDefault) ?? models[0];
      return model ? { provider: `${provider.provider}/${model.id}` } : { error: "The selected provider has no matching model. Check its settings or choose another provider." };
    } finally { api.dispose(); }
  });
  if (!chosen.provider) return { text: `${context.label} · ${chosen.error}` };
  const result = startMorningCheck.output.parse(await invokeChatHost(context.target, startMorningCheck.name, { serverId: context.target, workspaceId: workspace.id, provider: chosen.provider, fixture: false }));
  return { text: `${context.label} · Discovery ${result.launch?.error ? "needs attention" : "requested"}\n${workspace.projectName} / ${workspace.name}\nProvider: ${chosen.provider}\n${result.launch?.error ?? "The read-only tracker scan will save a report. No tickets imported or implementation started."}\nUse discovery to check progress, or open Kanban → Intake → Discover work.` };
}
