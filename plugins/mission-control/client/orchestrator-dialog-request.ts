// Per-chat dialog state. Opening a bubble never changes the selected tab or host.
export const orchestratorDialogKey = (workspaceId: string, agentId: string, serverId: string, kind: "review" | "attention") => JSON.stringify([workspaceId, agentId, serverId, kind]);
const open = new Set<string>();
const listeners = new Set<() => void>();
export const isOrchestratorDialogOpen = (key: string) => open.has(key);
export function setOrchestratorDialogOpen(key: string, value: boolean) {
  if (open.has(key) === value) return;
  if (value) open.add(key); else open.delete(key);
  for (const listener of [...listeners]) listener();
}
export function subscribeOrchestratorDialogs(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
