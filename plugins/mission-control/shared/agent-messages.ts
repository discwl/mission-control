// Paseo 0.12 records a prompt from another agent, and the notices about its children (finished, errored, needs
// permission, closed), as a tool call named agent_message carrying agentMessage { event, sender, text }, instead of
// a user message. Older hosts record them as user messages. Rows are read by shape, so every host version works.

export type AgentMessageEvent = "message" | "finished" | "errored" | "permission-required" | "closed";
export type AgentMessage = { event: AgentMessageEvent; sender: { id: string; title: string | null }; text: string };

const events: readonly string[] = ["message", "finished", "errored", "permission-required", "closed"];
const record = (value: unknown) => value && typeof value === "object" ? value as Record<string, unknown> : null;

/** The agent message a timeline row carries, or null for any other row. */
export function agentMessageOf(item: unknown): AgentMessage | null {
  const row = record(item);
  const message = row?.type === "tool_call" ? record(row.agentMessage) : null;
  const sender = record(message?.sender);
  if (!message || !sender || typeof message.event !== "string" || !events.includes(message.event) || typeof message.text !== "string") return null;
  if (typeof sender.id !== "string" || !sender.id) return null;
  return { event: message.event as AgentMessageEvent, sender: { id: sender.id, title: typeof sender.title === "string" && sender.title.trim() ? sender.title.trim() : null }, text: message.text };
}

/** A prompt's text, whether the user typed it or another agent sent it; null for every other row. */
export function promptText(item: unknown): string | null {
  const row = record(item);
  if (row?.type === "user_message") return typeof row.text === "string" ? row.text : null;
  const message = agentMessageOf(item);
  return message?.event === "message" ? message.text : null;
}

/** The prompt that started an agent: its first user message, or the first message another agent sent it. */
export function firstPromptText(items: readonly unknown[]): string | null {
  for (const item of items) {
    const text = promptText(item);
    if (text !== null) return text;
  }
  return null;
}

/** What happened, in words: "Message from Planner", "Planner finished", or "An agent finished" without a title. */
export function agentMessageHeadline(message: AgentMessage): string {
  const who = message.sender.title;
  switch (message.event) {
    case "message": return `Message from ${who ?? "another agent"}`;
    case "finished": return `${who ?? "An agent"} finished`;
    case "errored": return `${who ?? "An agent"} stopped with an error`;
    case "permission-required": return `${who ?? "An agent"} needs permission`;
    case "closed": return `${who ?? "An agent"} closed`;
  }
}
