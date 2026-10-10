import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const defaultVaultPath = "C:\\dev-vault";
const path = z.string().max(1024);
export const vaultEntrySchema = z.object({
  path, name: z.string(), kind: z.enum(["folder", "file", "link"]),
  size: z.number(), updatedAt: z.string(), revision: z.string(),
  editable: z.boolean(), manageable: z.boolean(), reason: z.string().nullable(),
});
export type VaultEntry = z.infer<typeof vaultEntrySchema>;
export const vaultStatusSchema = z.object({
  root: z.string(), name: z.string(), exists: z.boolean(), initialized: z.boolean(),
  obsidianRegistered: z.boolean().nullable(), obsidianVaultId: z.string().nullable(),
});
export const vaultFileSchema = vaultEntrySchema.extend({
  entryRevision: z.string(),
  content: z.string().nullable(), preview: z.enum(["markdown", "text", "image", "unsupported"]),
  dataUrl: z.string().nullable(),
});
export type VaultFile = z.infer<typeof vaultFileSchema>;
export const getVaultStatus = defineRpc({ name: "vault-status", input: z.object({}), output: vaultStatusSchema });
export const initializeVault = defineRpc({ name: "initialize-vault", input: z.object({}), output: vaultStatusSchema });
export const listVaultFolder = defineRpc({ name: "list-vault-folder", input: z.object({ path: path.default("") }), output: z.object({ entries: z.array(vaultEntrySchema) }) });
export const readVaultFile = defineRpc({ name: "read-vault-file", input: z.object({ path }), output: vaultFileSchema });
export const saveVaultFile = defineRpc({ name: "save-vault-file", input: z.object({ path, content: z.string().max(200_000), revision: z.string() }), output: vaultFileSchema });
export const createVaultEntry = defineRpc({ name: "create-vault-entry", input: z.object({ path, kind: z.enum(["folder", "note"]) }), output: vaultEntrySchema });
export const moveVaultEntry = defineRpc({ name: "move-vault-entry", input: z.object({ path, destination: path, revision: z.string() }), output: vaultEntrySchema });
export const trashVaultEntry = defineRpc({ name: "trash-vault-entry", input: z.object({ path, revision: z.string() }), output: z.object({ trashedPath: path }) });
export const locateTaskInVault = defineRpc({ name: "locate-task-in-vault", input: z.object({ taskId: z.string().regex(/^task_[a-f0-9-]+$/) }), output: z.object({ path }) });

/** A path URI selects the registered vault containing the actual file, avoiding name collisions. */
export function obsidianUri(root: string, name: string, file: string | null, useHostPath: boolean): string {
  if (useHostPath) return `obsidian://open?path=${encodeURIComponent(file ? `${root.replace(/[\\/]$/, "")}/${file}` : root)}`;
  return `obsidian://open?vault=${encodeURIComponent(name)}${file ? `&file=${encodeURIComponent(file)}` : ""}`;
}
