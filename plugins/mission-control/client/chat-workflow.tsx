import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { z } from "zod";
import { chatCommand } from "../shared/chat-workflow";

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
  const removeCommand = client.addSlashCommand({
    name: "mc", description: "Plans, reviews and draft PRs through Mission Control chat",
    argumentHint: "needs | plan <ticket> | yes approve <code> | draft PR <task ID>", context: "agent",
    async onSubmit({ args, agent, paseo, rpc }) {
      const result = await rpc(chatCommand, { agentId: agent.id, text: args.trim() || "help" });
      await paseo.agents.ref(agent.id).timeline.append({ type: "plugin", id: `mc-chat:${Date.now()}:${Math.random().toString(36).slice(2)}`, kind: "chat-workflow", version: 1, data: { text: result.text, ...(result.offerId ? { offerId: result.offerId } : {}) } });
    },
  });
  return () => { removeCommand(); removeRenderer(); };
}
