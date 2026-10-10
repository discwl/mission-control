import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// An orchestrator workspace on this host drives the work on one remote host. Its folder names that
// host in this file: { "schemaVersion": 1, "label": "Acme", "serverId": "srv_..." }. No secrets.
export const ORCHESTRATOR_HOST_FILE = "host.json";

export const orchestratorBindingSchema = z.object({ label: z.string().min(1), serverId: z.string().min(1) });
export type OrchestratorBinding = z.infer<typeof orchestratorBindingSchema>;

// The remote host each workspace orchestrates, for this installation host's workspaces only.
// A workspace without a host file is left out of both maps; problems explain files that can't be used.
export const getOrchestratorBindings = defineRpc({
  name: "orchestrator.bindings",
  input: z.object({ workspaceIds: z.array(z.string().min(1)).max(200) }),
  output: z.object({
    bindings: z.record(z.string(), orchestratorBindingSchema),
    problems: z.record(z.string(), z.string()),
  }),
});

// This host's Paseo server ID, so this installation's copy in the app can say which host it serves.
export const getHostIdentity = defineRpc({
  name: "host.identity",
  input: z.object({}),
  output: z.object({ serverId: z.string().min(1) }),
});

export type HostFileResult = { binding: OrchestratorBinding } | { problem: string } | null;

/**
 * Reads an orchestrator folder's host file. A file without a label isn't an orchestrator binding
 * (a vault's own host.json names its host with hostId), so it returns null rather than a problem.
 */
export function parseOrchestratorHostFile(text: string, localServerId: string): HostFileResult {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { problem: `${ORCHESTRATOR_HOST_FILE} isn't valid JSON.` }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { problem: `${ORCHESTRATOR_HOST_FILE} must be a JSON object.` };
  const file = value as Record<string, unknown>;
  if (!("label" in file)) return null;
  if (file.schemaVersion !== 1) return { problem: `${ORCHESTRATOR_HOST_FILE} needs "schemaVersion": 1.` };
  const label = typeof file.label === "string" ? file.label.trim() : "";
  const serverId = typeof file.serverId === "string" ? file.serverId.trim() : "";
  if (!label) return { problem: `${ORCHESTRATOR_HOST_FILE} needs the host's name in "label".` };
  if (!serverId) return { problem: `${ORCHESTRATOR_HOST_FILE} needs the host's Paseo server ID in "serverId".` };
  if (serverId === localServerId) return { problem: `${ORCHESTRATOR_HOST_FILE} names this host itself; an orchestrator drives another host.` };
  return { binding: { label, serverId } };
}
