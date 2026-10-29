import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { z } from "zod";
import { chatNativeCommand } from "../shared/chat-workflow";

const schema = z.object({ text: z.string(), offerId: z.string().optional() });
function ChatReceipt({ item, theme }: PluginTimelineItemProps<z.infer<typeof schema>>) {
  return <View style={{ padding: 14, gap: 8, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.surface0 }}>
    <Text style={{ color: theme.colors.foreground, fontWeight: "700" }}>Mission Control</Text>
    <Text selectable style={{ color: theme.colors.foreground, lineHeight: 21 }}>{item.data.text}</Text>
    {item.data.offerId ? <Text style={{ color: theme.colors.foregroundMuted }}>Reply with /mc followed by your answer. This command records your decision directly.</Text> : null}
  </View>;
}
export function registerChatClient(client: PluginClientContext) {
  const removeRenderer = client.addTimelineRenderer({ kind: "chat-workflow", version: 1, schema, Component: ChatReceipt });
  let failure = "";
  const removeErrorScreen = client.addScreen({ id: "chat-request-error", title: "Mission Control request", Component: ({ theme }) => <View style={{ padding: 20, gap: 12 }}>
    <Text accessibilityRole="alert" selectable style={{ color: theme.colors.foreground }}>{failure}</Text>
    <Text style={{ color: theme.colors.foregroundMuted }}>Check the task and its receipt before repeating an action. A missing response can mean the action already completed.</Text>
  </View> });
  const removeCommand = client.addSlashCommand({
    name: "mc", description: "Plans, reviews and draft PRs through Mission Control chat",
    argumentHint: "needs | plan <ticket> | yes approve <code> | draft PR <task ID>", context: "agent",
    async onSubmit({ args, agent, rpc }) {
      try {
        await rpc(chatNativeCommand, { agentId: agent.id, text: args.trim() || "help" });
      } catch (error) {
        failure = `Mission Control could not confirm this request. ${error instanceof Error ? error.message : String(error)}`;
        client.openScreen({ screenId: "chat-request-error" });
      }
    },
  });
  return () => { removeCommand(); removeRenderer(); removeErrorScreen(); };
}
