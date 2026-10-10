import type { PaseoAgent } from "@getpaseo/client";

export type PermissionRequest = PaseoAgent["pendingPermissions"][number];

/** What the agent wants to do, in one line of detail: the command, file, search or URL. */
export function permissionDetail(request: PermissionRequest): string | null {
  const detail = request.detail;
  if (detail) {
    if (detail.type === "shell") return detail.cwd ? `${detail.command}\n(in ${detail.cwd})` : detail.command;
    if (detail.type === "read" || detail.type === "edit" || detail.type === "write") return `${detail.type} ${detail.filePath}`;
    if (detail.type === "search") return `search ${detail.query}`;
    if (detail.type === "fetch") return `fetch ${detail.url}`;
  }
  if (request.input && Object.keys(request.input).length) {
    const text = JSON.stringify(request.input);
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  }
  return null;
}

export type PermissionChoice = { label: string; behavior: "allow" | "deny"; id?: string; tone: "primary" | "plain" | "danger" };

/** The request's own actions when it offers them, otherwise Allow and Deny. */
export function permissionChoices(request: PermissionRequest): PermissionChoice[] {
  if (request.actions?.length) {
    return request.actions.map(action => ({
      label: action.label, behavior: action.behavior, id: action.id,
      tone: action.variant === "danger" || action.behavior === "deny" ? "danger" : action.variant === "primary" ? "primary" : "plain",
    }));
  }
  return [{ label: "Allow", behavior: "allow", tone: "primary" }, { label: "Deny", behavior: "deny", tone: "danger" }];
}
