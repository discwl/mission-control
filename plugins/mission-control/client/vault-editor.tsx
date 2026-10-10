import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Image, Pressable, Text, TextInput, View } from "react-native";
import { saveVaultFile, type VaultFile } from "../shared/vault";
import { formatDateTime } from "./date-time";
import { MarkdownPreview } from "./markdown-preview";

type Colors = PluginSurfaceProps["theme"]["colors"];
const drafts = new Map<string, { content: string; revision: string }>();
const saves = new Set<string>();
const listeners = new Set<() => void>();
const keyFor = (serverId: string, path: string) => JSON.stringify([serverId, path]);
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function pending(key: string, value: boolean) { if (value) saves.add(key); else saves.delete(key); for (const listener of listeners) listener(); }
export const hasVaultDraft = (serverId: string, path: string) => drafts.has(keyFor(serverId, path)) || saves.has(keyFor(serverId, path));
export function discardVaultDraft(serverId: string, path: string) { const key = keyFor(serverId, path); if (saves.has(key)) return false; drafts.delete(key); return true; }
export const vaultError = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Request failed:\s*/, "").replace(/\s+requestType=.*$/, "");

export function VaultButton({ label, onPress, colors, disabled = false, active = false }: { label: string; onPress: () => void; colors: Colors; disabled?: boolean; active?: boolean }) {
  return <CompactLink label={label} onPress={onPress} colors={colors} disabled={disabled} selected={active} />;
}
export function VaultEditor({ file, serverId, colors, onDirty, onSaved, onReload }: {
  file: VaultFile; serverId: string; colors: Colors; onDirty: (dirty: boolean) => void; onSaved: () => Promise<unknown>; onReload: () => Promise<unknown>;
}) {
  const write = useRpc(saveVaultFile);
  const key = keyFor(serverId, file.path);
  const [draft, setDraft] = useState(() => drafts.get(key)?.content ?? file.content ?? "");
  const [editing, setEditing] = useState(() => drafts.has(key));
  const [error, setError] = useState<string | null>(null);
  const saving = useSyncExternalStore(subscribe, () => saves.has(key), () => false);
  const dirty = file.content !== null && draft !== file.content;
  useEffect(() => { onDirty(dirty || saving); }, [dirty, saving, onDirty]);
  async function save() {
    if (saves.has(key)) return;
    pending(key, true); setError(null);
    try {
      const savedDraft = drafts.get(key);
      if (savedDraft && savedDraft.revision !== file.revision) throw new Error("This file changed since your draft began. Copy your draft, then discard and reload before saving.");
      await write({ path: file.path, content: draft, revision: file.revision });
      drafts.delete(key); onDirty(false); await onSaved(); setEditing(false);
    } catch (cause) { setError(vaultError(cause)); }
    finally { pending(key, false); }
  }
  return <View style={{ gap: 12 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>Updated {formatDateTime(file.updatedAt)} · {Math.max(1, Math.ceil(file.size / 1024))} KB</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {file.editable ? <VaultButton label={editing ? "Preview" : "Edit Markdown"} active={editing} colors={colors} disabled={saving} onPress={() => setEditing(!editing)} /> : null}
        <VaultButton label={dirty ? "Discard & reload" : "Reload file"} colors={colors} disabled={saving} onPress={() => void onReload()} />
      </View>
    </View>
    {file.reason ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{file.reason}</Text> : null}
    {editing && file.editable ? <TextInput accessibilityLabel={`Edit ${file.path}`} multiline textAlignVertical="top" autoCapitalize="none" autoCorrect={false} editable={!saving} value={draft}
      onChangeText={content => { if (saves.has(key)) return; setDraft(content); if (content === file.content) drafts.delete(key); else drafts.set(key, { content, revision: drafts.get(key)?.revision ?? file.revision }); onDirty(content !== file.content); }}
      style={{ color: colors.foreground, backgroundColor: colors.surface0, borderColor: colors.border, borderWidth: 1, borderRadius: 7, minHeight: 430, padding: 16, fontSize: 14, lineHeight: 23, fontFamily: "monospace" }} />
      : <View style={{ backgroundColor: colors.surface0, borderColor: colors.border, borderWidth: 1, borderRadius: 7, padding: 18, minHeight: 300 }}>
        {file.preview === "markdown" ? <MarkdownPreview content={draft} colors={colors} documentPath={file.path} /> : file.preview === "text" ? <Text selectable style={{ color: colors.foreground, fontSize: 13, lineHeight: 21, fontFamily: "monospace" }}>{file.content}</Text> : file.preview === "image" && file.dataUrl ? <Image source={{ uri: file.dataUrl }} accessibilityLabel={file.name} resizeMode="contain" style={{ width: "100%", height: 400 }} /> : <Text style={{ color: colors.foregroundMuted }}>Preview unavailable for this file. It is still included in the vault browser.</Text>}
      </View>}
    {file.editable && (dirty || saving) ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
      <VaultButton label={saving ? "Saving…" : "Save note"} active colors={colors} disabled={!dirty || saving} onPress={() => void save()} />
      <Text style={{ color: colors.statusWarning, fontSize: 12 }}>Unsaved changes</Text>
    </View> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
  </View>;
}
import { CompactLink } from "./compact-link";
