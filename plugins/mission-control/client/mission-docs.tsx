import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Linking, Platform, Pressable, Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { AppModal as Modal } from "./app-modal";
import { Breadcrumbs } from "./breadcrumbs";
import { PageScrollView as ScrollView } from "./page-state";
import {
  createVaultEntry, defaultVaultPath, getVaultStatus, initializeVault, listVaultFolder,
  locateTaskInVault, moveVaultEntry, obsidianUri, readVaultFile, trashVaultEntry, type VaultEntry,
} from "../shared/vault";
import { discardVaultDraft, hasVaultDraft, VaultButton, VaultEditor, vaultError } from "./vault-editor";
import { VaultTree } from "./vault-tree";
import { VaultDocumentLinks } from "./document-links";
import { pageKey } from "./page-memory";
import { usePageState } from "./page-state";

type Props = Pick<PluginSurfaceProps, "theme" | "host" | "layout"> & { hostLabel: string; initialTaskId?: string | null; initialDocument?: { path: string; requestId: number } | null; onDocumentHandled?: () => void };
type Selection = { path: string; kind: VaultEntry["kind"] };
type Action = "note" | "folder" | "move" | "trash" | "setup" | null;
const parentPath = (path: string) => path.split("/").slice(0, -1).join("/");
function ancestors(path: string) {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

export function MissionDocs({ theme, host, hostLabel, layout, initialTaskId, initialDocument, onDocumentHandled }: Props) {
  const colors = theme.colors;
  const compact = layout.compact;
  const cache = useQueryClient();
  const statusRpc = useRpc(getVaultStatus);
  const initialize = useRpc(initializeVault);
  const list = useRpc(listVaultFolder);
  const read = useRpc(readVaultFile);
  const create = useRpc(createVaultEntry);
  const move = useRpc(moveVaultEntry);
  const trash = useRpc(trashVaultEntry);
  const locate = useRpc(locateTaskInVault);
  const scope = pageKey(host.id, "docs");
  const [selected, setSelected] = usePageState<Selection>(`${scope}:selection`, { path: "", kind: "folder" });
  const [expanded, setExpanded] = usePageState(`${scope}:expanded`, () => new Set(ancestors(selected.path)));
  const [treeOpen, setTreeOpen] = usePageState(`${scope}:tree-open`, false);
  const [dirty, setDirty] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const [action, setAction] = useState<Action>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handledTask = useRef<string | null>(null);
  const handledDocument = useRef<number | null>(null);
  const status = useQuery({ queryKey: ["mission-control", "vault-status", host.id], queryFn: () => statusRpc({}), staleTime: 15_000, retry: false });
  const folderPath = selected.kind === "folder" ? selected.path : parentPath(selected.path);
  const folder = useQuery({ queryKey: ["mission-control", "vault-folder", host.id, folderPath], queryFn: () => list({ path: folderPath }), enabled: status.data?.exists === true, retry: false });
  const parent = useQuery({ queryKey: ["mission-control", "vault-folder", host.id, parentPath(selected.path)], queryFn: () => list({ path: parentPath(selected.path) }), enabled: status.data?.exists === true && selected.kind === "folder" && selected.path !== "", retry: false });
  const file = useQuery({ queryKey: ["mission-control", "vault-file", host.id, selected.path], queryFn: () => read({ path: selected.path }), enabled: status.data?.exists === true && selected.kind === "file", retry: false });
  const taskLocation = useQuery({ queryKey: ["mission-control", "vault-task-location", host.id, initialTaskId], queryFn: () => locate({ taskId: initialTaskId! }), enabled: Boolean(initialTaskId), retry: false });
  const selectedEntry = selected.kind === "file" ? file.data : (selected.kind === "folder" ? parent.data : folder.data)?.entries.find(entry => entry.path === selected.path);
  const root = status.data?.root ?? defaultVaultPath;
  const vaultName = status.data?.name ?? "dev-vault";

  function canLeave() {
    if (busy || dirty || hasVaultDraft(host.id, selected.path)) {
      setError("Save or discard your note before changing files or opening it in Obsidian.");
      return false;
    }
    return true;
  }
  function select(next: Selection) {
    if (next.path === selected.path) return;
    if (!canLeave()) return;
    setSelected(next); setDirty(false); setError(null); setMessage(null);
    setExpanded(current => new Set([...current, ...ancestors(next.path), ...(next.kind === "folder" ? [next.path] : [])]));
    if (compact && next.kind !== "folder") setTreeOpen(false);
  }
  useEffect(() => {
    if (!initialTaskId || !taskLocation.data || handledTask.current === initialTaskId) return;
    handledTask.current = initialTaskId;
    if (hasVaultDraft(host.id, selected.path)) { setError("Your draft has been restored. Save or discard it before opening the task document."); return; }
    const next: Selection = { path: taskLocation.data.path, kind: "file" };
    setSelected(next); setExpanded(new Set(ancestors(next.path)));
  }, [initialTaskId, taskLocation.data, host.id]);

  useEffect(() => {
    if (!initialDocument || handledDocument.current === initialDocument.requestId) return;
    handledDocument.current = initialDocument.requestId;
    select({ path: initialDocument.path, kind: "file" });
    onDocumentHandled?.();
  }, [initialDocument]);

  async function refresh() {
    setError(null);
    await Promise.all([
      status.refetch(),
      cache.invalidateQueries({ queryKey: ["mission-control", "vault-folder", host.id] }),
      cache.invalidateQueries({ queryKey: ["mission-control", "vault-file", host.id] }),
    ]);
  }
  async function openUri(uri: string) {
    setError(null);
    try {
      if (Platform.OS === "web") {
        // React Native Web accepts a target, defaulting to _blank. External protocols
        // must use _self so Electron does not leave an empty child window behind.
        const openWebUrl = Linking.openURL as (url: string, target: string) => Promise<void>;
        await openWebUrl.call(Linking, uri, "_self");
      } else {
        await Linking.openURL(uri);
      }
    }
    catch { setError("Obsidian could not be opened. Install Obsidian on this device, then open this folder as a vault in its vault manager."); setAction("setup"); }
  }
  function openObsidian(path: string | null, skipSetup = false) {
    if (!canLeave()) return;
    if (!skipSetup && (!status.data?.initialized || status.data.obsidianRegistered === false)) { setAction("setup"); return; }
    void openUri(obsidianUri(root, vaultName, path, false));
  }
  function begin(next: Exclude<Action, null | "setup">) {
    if (!canLeave()) return;
    setError(null); setMessage(null); setAction(next);
    setInput(next === "move" ? selected.path : `${folderPath ? `${folderPath}/` : ""}${next === "note" ? "Untitled.md" : next === "folder" ? "New folder" : ""}`);
  }
  async function mutate() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      let next: Selection | null = null;
      if (action === "note" || action === "folder") {
        const entry = await create({ path: input.trim(), kind: action });
        next = { path: entry.path, kind: entry.kind };
      } else if ((action === "move" || action === "trash") && selectedEntry) {
        const revision = selected.kind === "file" ? file.data!.entryRevision : selectedEntry.revision;
        if (action === "move") {
          const entry = await move({ path: selected.path, destination: input.trim(), revision });
          next = { path: entry.path, kind: entry.kind };
        } else {
          const result = await trash({ path: selected.path, revision });
          next = { path: parentPath(selected.path), kind: "folder" };
          setMessage(`Moved to ${result.trashedPath}. You can recover it from the vault's .trash folder.`);
        }
      }
      if (next) {
        setSelected(next); setDirty(false);
        setExpanded(current => new Set([...current, ...ancestors(next.path)]));
        if (compact && next.kind === "file") setTreeOpen(false);
      }
      setAction(null); await refresh();
    } catch (cause) { setError(vaultError(cause)); }
    finally { setBusy(false); }
  }
  async function prepareVault() {
    if (busy) return;
    setBusy(true); setError(null);
    try { await initialize({}); await refresh(); }
    catch (cause) { setError(vaultError(cause)); }
    finally { setBusy(false); }
  }
  const button = (label: string, onPress: () => void, disabled = false) => <VaultButton key={label} label={label} onPress={onPress} disabled={disabled || busy} colors={colors} />;
  const queryError = status.error ?? (selected.kind === "file" ? file.error : folder.error) ?? taskLocation.error;
  const tree = <View style={{ width: compact ? "100%" : 270, minHeight: 0, maxHeight: compact ? 360 : undefined, backgroundColor: colors.surface0, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
    <Pressable accessibilityRole="button" accessibilityLabel="Browse vault root" onPress={() => select({ path: "", kind: "folder" })} style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 46, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: colors.border }}><Icon name="FolderOpen" size={17} color={colors.accent} /><Text style={{ color: colors.foreground, fontWeight: "600", flex: 1 }}>{vaultName}</Text></Pressable>
    <ScrollView memoryKey={pageKey(scope, "tree")} style={{ flex: compact ? undefined : 1, minHeight: 0 }} contentContainerStyle={{ paddingVertical: 5 }} nestedScrollEnabled>
      {status.data?.exists ? <VaultTree path="" serverId={host.id} selected={selected.path} expanded={expanded} colors={colors} onSelect={select} onToggle={path => setExpanded(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; })} /> : <Text style={{ color: colors.foregroundMuted, padding: 12 }}>Prepare the vault to start adding notes.</Text>}
    </ScrollView>
  </View>;

  return <VaultDocumentLinks serverId={host.id} scope={`${host.id}:${selected.path}`} onOpen={path => select({ path, kind: "file" })}><View style={{ flex: compact ? undefined : 1, minHeight: 0, gap: 12 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
      <View style={{ flex: 1, minWidth: 180, gap: 3 }}><Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 19, fontWeight: "600" }}>Vault documents</Text><Breadcrumbs colors={colors} segments={[hostLabel, vaultName]} /><Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{root}</Text></View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{button("Open vault in Obsidian", () => openObsidian(null), status.isPending)}{button("Set up Obsidian", () => { setError(null); setAction("setup"); })}{button("Refresh vault", () => void refresh())}</View>
    </View>
    {status.data && (!status.data.initialized || status.data.obsidianRegistered === false) ? <Text style={{ color: colors.statusWarning, fontSize: 12 }}>{!status.data.initialized ? "This folder has not been prepared for Obsidian yet." : `This folder is prepared, but Obsidian on ${hostLabel} has not registered it yet.`} Use Set up Obsidian to finish.</Text> : null}
    {error || queryError ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{error ?? vaultError(queryError)}</Text> : null}
    {message ? <Text style={{ color: colors.statusSuccess, fontSize: 12 }}>{message}</Text> : null}
    {compact ? button(treeOpen ? "Hide files" : "Browse files", () => setTreeOpen(!treeOpen)) : null}
    <View style={{ flex: compact ? undefined : 1, minHeight: 0, flexDirection: compact ? "column" : "row", gap: 14 }}>
      {!compact || treeOpen ? tree : null}
      <ScrollView memoryKey={pageKey(scope, "content", selected.path)} scrollEnabled={!compact} style={{ flex: compact ? undefined : 1, minWidth: 0, minHeight: 0 }} contentContainerStyle={{ gap: 13, paddingBottom: 18 }} nestedScrollEnabled>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
          {button("Vault root", () => select({ path: "", kind: "folder" }), selected.path === "")}
          {selected.path ? button("Up a folder", () => select({ path: parentPath(selected.path), kind: "folder" })) : null}
          <View style={{ flex: 1, minWidth: 100 }}><Breadcrumbs colors={colors} segments={[vaultName, ...selected.path.split("/").filter(Boolean)]} accessibilityLabel={selected.path || "All files and folders"} /></View>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
          {button("New note", () => begin("note"), !status.data?.exists)}{button("New folder", () => begin("folder"), !status.data?.exists)}
          {selected.kind === "file" ? button("Open file in Obsidian", () => openObsidian(selected.path)) : null}
          {selectedEntry?.manageable ? <>{button("Rename or move", () => begin("move"))}{button("Move to trash", () => begin("trash"))}</> : null}
        </View>
        {status.isPending || (status.data?.exists && (selected.kind === "file" ? file.isPending : folder.isPending)) ? <Text style={{ color: colors.foregroundMuted }}>Loading vault…</Text> : null}
        {selected.kind === "folder" ? <View style={{ gap: 6 }}>
          <Text accessibilityRole="header" style={{ color: colors.foreground, fontWeight: "600", fontSize: 17 }}>{selected.path.split("/").pop() || vaultName}</Text>
          {folder.data?.entries.length === 0 ? <Text style={{ color: colors.foregroundMuted }}>This folder is empty. Add a note or folder above.</Text> : null}
          {folder.data?.entries.map(entry => <Pressable key={entry.path} accessibilityRole="button" accessibilityLabel={`Open ${entry.path}`} onPress={() => select(entry)} style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderRadius: 7, backgroundColor: colors.surface0, borderWidth: 1, borderColor: colors.border }}>
            <Icon name={entry.kind === "folder" ? "Folder" : entry.kind === "link" ? "Link" : "FileText"} size={18} color={entry.kind === "folder" ? colors.accent : colors.foregroundMuted} />
            <Text numberOfLines={2} style={{ color: colors.foreground, flex: 1, fontSize: 13 }}>{entry.name}</Text>
            <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{entry.kind === "folder" ? "Folder" : entry.kind === "link" ? "Link" : `${Math.max(1, Math.ceil(entry.size / 1024))} KB`}</Text>
            {!entry.manageable ? <Icon name="Lock" size={13} color={colors.foregroundMuted} /> : null}
          </Pressable>)}
        </View> : selected.kind === "link" ? <Text style={{ color: colors.foregroundMuted }}>Linked folders and files are listed here but are not followed by the vault browser.</Text> : file.data ? <VaultEditor key={`${file.data.path}:${file.data.revision}:${editorVersion}`} file={file.data} serverId={host.id} colors={colors} onDirty={setDirty}
          onSaved={async () => { setError(null); await file.refetch(); await cache.invalidateQueries({ queryKey: ["mission-control", "vault-folder", host.id] }); }}
          onReload={async () => { if (!discardVaultDraft(host.id, selected.path)) return; setDirty(false); setError(null); await file.refetch(); setEditorVersion(value => value + 1); }} /> : null}
      </ScrollView>
    </View>
    <Modal colors={colors} maxWidth={560} open={action !== null} title={action === "setup" ? "Set up Obsidian" : action === "trash" ? "Move to vault trash?" : action === "move" ? "Rename or move" : action === "note" ? "New Markdown note" : "New folder"} onOpenChange={open => { if (!open && !busy) setAction(null); }}>
      <Modal.Content contentContainerStyle={{ padding: 22, gap: 14 }}>
          {action === "setup" ? <>
            <Text selectable style={{ color: colors.foreground }}>{root}</Text>
            <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{status.data?.initialized ? "1. Obsidian settings folder is present." : "1. Prepare this folder as an Obsidian vault. Existing files and settings are preserved."}</Text>
            {!status.data?.initialized ? button("Initialize vault", () => void prepareVault()) : null}
            <Text style={{ color: colors.foregroundMuted, fontSize: 13 }}>{status.data?.obsidianRegistered === true ? `2. Registered in Obsidian on ${hostLabel}.` : `2. In Obsidian's vault manager, select “Open folder as vault” and choose ${root}. Do this once on each device where you use the vault.`}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{button("Open vault manager", () => void openUri("obsidian://choose-vault"), !status.data?.initialized)}{button("Check again", () => void refresh())}</View>
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Obsidian opens on the device you are using now. For a remote host or mobile device, open a local or synced copy named {vaultName}. Mission Control does not sync vault files between devices.</Text>
            {button("Open vault on this device", () => openObsidian(null, true), !status.data?.initialized)}
          </> : action === "trash" ? <Text style={{ color: colors.foregroundMuted }}>Move {selected.path}{selected.kind === "folder" ? " and everything inside it" : ""} to .trash inside the vault? It can be recovered there. Existing note links are not rewritten.</Text> : <>
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>Path relative to the vault. Parent folders must already exist.{action === "move" ? " Existing note links are not rewritten." : action === "note" ? " Use a .md extension." : ""}</Text>
            <TextInput accessibilityLabel="Vault entry path" autoCapitalize="none" autoCorrect={false} value={input} onChangeText={setInput} editable={!busy} style={{ color: colors.foreground, minHeight: 44, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 7, backgroundColor: colors.surface0 }} />
          </>}
          {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 8 }}>
            {button(action === "setup" ? "Done" : "Cancel", () => setAction(null))}
            {action !== "setup" ? button(busy ? "Working…" : action === "trash" ? "Move to trash" : action === "move" ? "Move" : "Create", () => void mutate(), !input.trim() && action !== "trash") : null}
          </View>
      </Modal.Content>
    </Modal>
  </View></VaultDocumentLinks>;
}
