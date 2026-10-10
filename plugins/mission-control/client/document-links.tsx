import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Text } from "react-native";
import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "./host-rpc";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { getVaultStatus, listVaultFolder, locateTaskInVault, readVaultFile } from "../shared/vault";
import { resolveDocumentLink, type DocumentLink } from "./document-link-model";

type Open = (link: DocumentLink, sourcePath?: string) => Promise<void>;
const Navigation = createContext<Open | null>(null);
export function VaultDocumentLinks({ serverId, scope, onOpen, children }: { serverId: string; scope: string; onOpen: (path: string) => void; children: ReactNode }) {
  const status = useRpc(getVaultStatus), list = useRpc(listVaultFolder), locate = useRpc(locateTaskInVault), read = useRpc(readVaultFile);
  const version = useRef(0), latestOpen = useRef(onOpen);
  latestOpen.current = onOpen;
  useEffect(() => { version.current++; return () => { version.current++; }; }, [serverId, scope]);
  async function open(link: DocumentLink, sourcePath?: string) {
    const current = ++version.current;
    const vault = await status({});
    if (!vault.exists) throw new Error("This host's vault is unavailable. Open Docs to check its status.");
    const path = await resolveDocumentLink(link, { root: vault.root, sourcePath, list: path => list({ path }), locate: taskId => locate({ taskId }), read: path => read({ path }) });
    if (version.current === current) latestOpen.current(path);
  }
  return <Navigation.Provider value={open}>{children}</Navigation.Provider>;
}
export function DocumentLinkText({ link, sourcePath, colors }: { link: DocumentLink; sourcePath?: string; colors: PluginSurfaceProps["theme"]["colors"] }) {
  const open = useContext(Navigation), toast = useToast();
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function follow() {
    if (busy) return;
    if (!open) { toast.error("Open this document in Docs to follow its vault links."); return; }
    setBusy(true);
    try { await open(link, sourcePath); }
    catch (cause) { if (active.current) toast.error(cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string" ? cause.message : String(cause)); }
    finally { if (active.current) setBusy(false); }
  }
  return <Text accessibilityRole="link" accessibilityLabel={link.label} accessibilityHint="Open the linked document in Docs" accessibilityState={{ disabled: busy }}
    {...(Platform.OS === "web" ? { title: `Open ${link.label} in Docs`, tabIndex: 0 } : {})}
    onPress={() => void follow()} style={{ color: colors.accent, textDecorationLine: "underline", opacity: busy ? 0.6 : 1 }}>{link.label}</Text>;
}
