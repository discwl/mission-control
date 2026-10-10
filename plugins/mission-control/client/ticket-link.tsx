import { CompactLink } from "./compact-link";
import { openExternalUrl, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Ticket } from "../shared/tasks";
import { ticketSystemLabels } from "../shared/tickets";

type Colors = PluginSurfaceProps["theme"]["colors"];

/** The task's external ticket: system, key, and a link that opens it in the tracker. */
export function TicketLink({ ticket, colors }: { ticket: Ticket; colors: Colors }) {
  const [error, setError] = useState<string | null>(null);
  return <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
    <Text style={{ color: colors.foreground, fontSize: 13 }}>{ticketSystemLabels[ticket.system]} <Text selectable style={{ fontWeight: "600" }}>{ticket.key}</Text></Text>
    <CompactLink colors={colors} label={"Open ticket ↗"} accessibilityRole="link" accessibilityLabel={`Open ${ticket.key} in ${ticketSystemLabels[ticket.system]}`} onPress={() => { void openExternalUrl(ticket.url).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); }} />
    {error ? <Text style={{ color: colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
  </View>;
}
