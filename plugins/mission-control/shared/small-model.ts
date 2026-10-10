import type { PaseoApi } from "@getpaseo/client";

// A small, fast model run as a short-lived Paseo agent: name suggestions and the commit and pull request text
// that follows paseo.json. The agent is still an ordinary provider session in a workspace, so its provider may
// load that workspace's project instructions (for example CLAUDE.md or AGENTS.md) and could read files if it
// ignored the instruction not to use tools.

export type SmallModel = { provider: string; label: string; thinkingOptionId?: string };
type CatalogModel = { id: string; label: string; isSelectable?: boolean; thinkingOptions?: { id: string }[] };

/** Prefers Haiku, then GPT-6-Luna on low effort. Never falls back to a large model. */
export function pickSmallModel(catalogs: { provider: string; models: CatalogModel[] }[]): SmallModel | null {
  const usable = catalogs.flatMap(catalog => catalog.models.filter(model => model.isSelectable !== false).map(model => ({ ...model, provider: catalog.provider })));
  const matches = (model: CatalogModel, word: string) => `${model.id} ${model.label}`.toLowerCase().includes(word);
  const haiku = usable.find(model => matches(model, "haiku"));
  if (haiku) return { provider: `${haiku.provider}/${haiku.id}`, label: haiku.label };
  const luna = usable.find(model => matches(model, "luna"));
  if (!luna) return null;
  const low = luna.thinkingOptions?.find(option => option.id === "low");
  return { provider: `${luna.provider}/${luna.id}`, label: `${luna.label}${low ? " (low)" : ""}`, ...(low ? { thinkingOptionId: low.id } : {}) };
}

export async function resolveSmallModel(paseo: PaseoApi): Promise<SmallModel> {
  const catalogs = await Promise.all(["claude", "codex"].map(async provider => {
    try {
      const result = await paseo.providers.listModels(provider);
      return { provider, models: result.error ? [] : result.models ?? [] };
    } catch {
      return { provider, models: [] };
    }
  }));
  const model = pickSmallModel(catalogs);
  if (!model) throw new Error("No small model is available on this host. Enable Claude (Haiku) or Codex (GPT-6-Luna) in Paseo.");
  return model;
}

/** The JSON in a model's answer: fenced or bare, an object or an array, whichever starts first. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const starts = [body.indexOf("{"), body.indexOf("[")].filter(index => index >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  const end = start < 0 ? -1 : body.lastIndexOf(body[start] === "[" ? "]" : "}");
  if (start < 0 || end <= start) throw new Error("The model did not return JSON.");
  return JSON.parse(body.slice(start, end + 1));
}

async function modeFor(paseo: PaseoApi, provider: string): Promise<string | undefined> {
  try {
    const ids = new Set((await paseo.providers.listModes(provider.split("/")[0])).modes?.map(mode => mode.id) ?? []);
    return ["read-only", "default"].find(id => ids.has(id));
  } catch {
    return undefined;
  }
}

export type SmallModelRequest = {
  title: string;
  // Paseo label mission-control.role, so Mission Control's own lists can hide the agent.
  role: string;
  systemPrompt: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  timeoutMs?: number;
  // What the agent is doing, for its error messages ("The naming agent …").
  noun: string;
};

/** Runs one short-lived agent in `workspaceId`, returns its final answer's text, then archives it. */
export async function askSmallModel(paseo: PaseoApi, workspaceId: string, model: SmallModel, request: SmallModelRequest): Promise<string> {
  const modeId = await modeFor(paseo, model.provider);
  const agent = await paseo.workspaces.ref(workspaceId).agents.create({
    config: { provider: model.provider, systemPrompt: request.systemPrompt, ...(modeId ? { modeId } : {}), ...(model.thinkingOptionId ? { thinkingOptionId: model.thinkingOptionId } : {}) },
    title: request.title,
    prompt: request.prompt,
    outputSchema: request.outputSchema,
    labels: { "mission-control.role": request.role },
  });
  try {
    const result = await agent.waitForFinish(request.timeoutMs ?? 180_000);
    if (result.status !== "idle") throw new Error(result.error || (result.status === "permission" ? `The ${request.noun} asked for a permission. Nothing was changed.` : `The ${request.noun} stopped (${result.status}).`));
    let text = result.lastMessage?.trim() ?? "";
    if (!text) {
      // Some providers leave lastMessage empty; the answer is then the last assistant message.
      const tail = await agent.timeline.refetch({ direction: "tail", limit: 20, projection: "projected" });
      for (const { item } of [...tail.entries].reverse()) {
        if (item.type === "assistant_message" && item.text.trim()) { text = item.text; break; }
      }
    }
    return text;
  } finally {
    await agent.archive().catch(() => undefined);
  }
}
