import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { decisionEntrySchema } = require("../shared/decisions.ts");
const { questionEntrySchema } = require("../shared/questions.ts");
const {
  conversationSteps, decisionNeed, decisionWhere, errorCard, lastSentences, latestAgentQuote, pendingPrompts, permissionCard,
  mayReadChat, questionCard, replyRoute, sendReply, taskLine, timelineKey, timelineQueryOptions, waitingCardReadsChat, waitingCards, wantsTo,
} = require("./attention-model.ts");
const { QueryClient, QueryObserver, focusManager, onlineManager } = require("@tanstack/query-core");

const sample = decisionEntrySchema.parse(JSON.parse(readFileSync(new URL("./fixtures/sample-decision.json", import.meta.url), "utf8")));
const local = "srv_local";
const remote = "srv_remote";
const hosts = [{ serverId: local, label: "personal", status: "online" }, { serverId: remote, label: "Globex", status: "online" }];
const taskId = "task_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const taskTitles = { [taskId]: "24 · Attention cards that explain themselves" };
const workspace = { id: "wks_local", name: "Attention cards", projectName: "development-flow" };
const agent = (fields = {}) => ({
  id: "agent-1", workspaceId: "wks_local", name: "Builder", taskId: null, status: "idle", archivedAt: null, permissions: [],
  requiresAttention: false, attentionReason: null, attentionTimestamp: null, lastUserMessageAt: "2026-09-28T09:00:00Z", lastError: null, ...fields,
});
const shell = { id: "perm-1", provider: "claude", name: "Bash", kind: "tool", title: "Bash", detail: { type: "shell", command: "npm test", cwd: "C:\\repo" } };
const question = (fields = {}, plain = { status: "Pause works. Resume needs a place for notes.", need: "Should notes live with the task or the run?", recommendation: "With the task." }) => questionEntrySchema.parse({
  taskTitle: "24 · Attention cards that explain themselves", projectId: "prj_test",
  question: {
    schemaVersion: 1, questionId: "question_cccccccc-cccc-4ccc-cccc-cccccccccccc", taskId, runId: "run_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    serverId: local, workspaceId: "wks_local", agentId: "agent-1", status: "open", question: "Store pause notes in task.md or the run folder?",
    askedAt: "2026-09-28T10:00:00Z", answeredAt: null, answer: null, plain, ...fields,
  },
});
const timeline = [
  { type: "user_message", text: "Build the pause button." },
  { type: "reasoning", text: "Thinking about notes." },
  { type: "assistant_message", text: "I'll start with the server." },
  { type: "tool_call", name: "Bash", status: "failed", detail: { type: "shell", command: "npm test" }, error: "exit 1" },
  { type: "usage_updated" },
  { type: "assistant_message", text: "## Status\n\nThe **pause** button works. Tests pass. Notes are saved per task. Resume still needs a place to keep them. Should they live with the task?" },
];

test("the task line names the task from the agent's task label, else the agent's title, then host / project / workspace", () => {
  assert.deepEqual(taskLine({ taskId, agentName: "Builder", taskTitles, hostLabel: "personal", workspace }),
    { title: "24 · Attention cards that explain themselves", place: "personal / development-flow / Attention cards" });
  assert.deepEqual(taskLine({ taskId: "task_unknown", agentName: "Builder", taskTitles, hostLabel: "Globex", workspace: null }), { title: "Builder", place: "Globex" });
  assert.deepEqual(taskLine({ agentName: "Builder", hostLabel: "personal", workspace }).title, "Builder");
});

test("the chat fallback quotes the agent's latest message verbatim, trimmed to its last sentences, and never invents text", () => {
  assert.equal(latestAgentQuote(timeline), "…Notes are saved per task. Resume still needs a place to keep them. Should they live with the task?");
  // Every word of the quote comes from the message, in order.
  const words = latestAgentQuote(timeline).replace(/^…/, "").split(" ");
  assert.ok("Status The pause button works. Tests pass. Notes are saved per task. Resume still needs a place to keep them. Should they live with the task?".includes(words.join(" ")));
  assert.equal(latestAgentQuote([{ type: "assistant_message", text: "Short and done." }]), "Short and done.");
  assert.equal(latestAgentQuote([{ type: "user_message", text: "Hello?" }, { type: "assistant_message", text: "   " }]), null, "no message, no quote");
  assert.equal(latestAgentQuote(undefined), null);
  const long = lastSentences(`${"word ".repeat(200)}end.`);
  assert.ok(long.length <= 401 && long.startsWith("…") && long.endsWith("word end."));
});

test("the conversation shows the last messages and steps, trimmed, without reasoning or bookkeeping", () => {
  assert.deepEqual(conversationSteps(timeline).map(step => [step.kind, step.text.slice(0, 40)]), [
    ["you", "Build the pause button."],
    ["agent", "I'll start with the server."],
    ["step", "Bash: npm test (failed)"],
    ["agent", "Status The pause button works. Tests pas"],
  ]);
  assert.equal(conversationSteps(timeline, 2).length, 2);
  assert.ok(conversationSteps([{ type: "assistant_message", text: "x".repeat(1000) }])[0].text.length <= 280);
});

test("permission cards: task line, where it's at from the chat, and what it wants to do in plain words", () => {
  const task = taskLine({ taskId, agentName: "Builder", taskTitles, hostLabel: "personal", workspace });
  const card = permissionCard(shell, task, latestAgentQuote(timeline));
  assert.equal(card.badge, "PERMISSION");
  assert.equal(card.task.title, "24 · Attention cards that explain themselves");
  assert.deepEqual(card.where, { text: latestAgentQuote(timeline), source: "chat" });
  assert.equal(card.need, "Wants to: Run a command: npm test");
  assert.equal(card.recommendation, null);
  // Without any agent message there is no "where it's at" line rather than a made-up one.
  assert.equal(permissionCard(shell, task, null).where, null);
  assert.equal(wantsTo({ ...shell, detail: { type: "edit", filePath: "client/a.ts" } }), "Edit a file: client/a.ts");
  assert.equal(wantsTo({ ...shell, detail: { type: "fetch", url: "https://example.com" } }), "Open a web page: https://example.com");
  assert.equal(wantsTo({ id: "p", provider: "claude", name: "ExitPlanMode", kind: "plan" }), "Start work on the plan it proposed");
  assert.equal(wantsTo({ id: "p", provider: "claude", name: "mcp__paseo__list", kind: "tool", title: "List agents" }), "List agents");
});

test("decision cards: where it's at is the agent's plain summary, or a chat quote, or a plain generic line", () => {
  assert.deepEqual(decisionWhere(sample, "ignored", "generic"), {
    text: "You can now pause a task and pick it up later; the agent saves where it got to and its notes. The review found two problems: one can lose notes, the other is a confusing label.",
    source: "agent",
  });
  assert.match(decisionNeed(sample), /^Decide on the 2 issues the review found: fix them first, or accept the work as it is\.$/);
  const bare = { ...sample, decision: { ...sample.decision, plain: null } };
  assert.deepEqual(decisionWhere(bare, "…It's done.", "generic"), { text: "…It's done.", source: "chat" });
  assert.deepEqual(decisionWhere(bare, null, "The work is done and has been reviewed."), { text: "The work is done and has been reviewed.", source: "generic" });
  const plan = { ...sample, findings: [], decision: { ...sample.decision, kind: "plan", plain: { built: "A pause button.", found: "", recommendation: { action: "accept", reason: "Small." } } } };
  assert.deepEqual(decisionWhere(plan, null, "generic"), { text: "A pause button.", source: "agent" });
  assert.equal(decisionNeed(plan), "Approve the plan so the agent can start, or say what to change.");
  assert.equal(decisionNeed({ ...sample, findings: [] }), "Accept the work so it can be delivered, or ask for changes.");
});

test("question cards use the agent's own summary, and quote the chat when a record has none", () => {
  const task = { title: "24 · Attention cards that explain themselves", place: "personal / development-flow / Attention cards" };
  const card = questionCard(question(), task, "…ignored");
  assert.deepEqual([card.badge, card.where, card.need, card.recommendation], ["WAITING FOR YOU", { text: "Pause works. Resume needs a place for notes.", source: "agent" }, "Should notes live with the task or the run?", "With the task."]);
  const bare = questionCard(question({}, "malformed"), task, "…Should they live with the task?");
  assert.deepEqual([bare.where, bare.need, bare.recommendation], [{ text: "…Should they live with the task?", source: "chat" }, "Store pause notes in task.md or the run folder?", null]);
  assert.equal(questionCard(question({}, { status: "Halfway.", need: "Pick one." }), task, null).recommendation, null);
});

test("error cards say what failed, from Paseo's last error only, never from the chat", () => {
  const task = { title: "Builder", place: "Globex" };
  const card = errorCard(agent({ lastError: "Provider rate limit reached. Try again later." }), task);
  assert.deepEqual([card.badge, card.where, card.need], ["ERROR", null, "It stopped with an error: Provider rate limit reached. Try again later."]);
  assert.equal(errorCard(agent(), task).need, "It stopped with an error: Paseo recorded no details");
});

test("cards read an agent's chat on their own only for a live agent, since reading a stopped agent's chat wakes it", () => {
  // Live agents: waiting on a permission, idle after a question, or running.
  for (const status of ["idle", "running", "initializing"]) assert.equal(mayReadChat(agent({ status })), true, status);
  // Never closed, errored (by status or by Paseo's error flag), archived, or unknown to the roster.
  assert.equal(mayReadChat(agent({ status: "closed" })), false);
  assert.equal(mayReadChat(agent({ status: "error" })), false);
  assert.equal(mayReadChat(agent({ status: "idle", attentionReason: "error", requiresAttention: true })), false);
  assert.equal(mayReadChat(agent({ archivedAt: "2026-09-29T00:00:00Z" })), false);
  assert.equal(mayReadChat(null), false);
  assert.equal(mayReadChat(undefined), false);

  // Waiting cards: an error card never reads the chat; a question reads it only without its own summary, from a live agent.
  const erroring = agent({ id: "globex-agent", workspaceId: null, status: "error", requiresAttention: true, attentionReason: "error", attentionTimestamp: "2026-09-28T11:00:00Z", lastError: "Crashed" });
  const flaggedOnly = { ...erroring, id: "globex-flagged", status: "idle" };
  const rosters = [{ data: { workspaces: [workspace], agents: [agent()] } }, { data: { workspaces: [], agents: [erroring, flaggedOnly] } }];
  const cards = waitingCards({ hosts, rosters, localServerId: local, questions: [question()], taskTitles });
  assert.deepEqual(cards.map(card => [card.kind, card.agentId, waitingCardReadsChat(card)]), [["question", "agent-1", false], ["error", "globex-agent", false], ["error", "globex-flagged", false]]);
  const [bare] = waitingCards({ hosts, rosters, localServerId: local, questions: [question({}, "malformed")], taskTitles });
  assert.equal(waitingCardReadsChat(bare), true, "a question without a summary, from an idle agent, is quoted");
  assert.equal(waitingCardReadsChat({ ...bare, agent: { ...bare.agent, status: "closed" } }), false);
});

test("permission prompts from every online host are still listed, and offline hosts' are not", () => {
  const rosters = [
    { data: { workspaces: [workspace], agents: [agent({ permissions: [shell] }), agent({ id: "gone", permissions: [shell], archivedAt: "2026-09-28T00:00:00Z" })] } },
    { data: { workspaces: [], agents: [agent({ id: "globex-agent", workspaceId: null, permissions: [{ ...shell, id: "perm-2" }] })] } },
  ];
  assert.deepEqual(pendingPrompts(hosts, rosters).map(({ host, agent, request }) => [host.serverId, agent.id, request.id]), [[local, "agent-1", "perm-1"], [remote, "globex-agent", "perm-2"]]);
  assert.deepEqual(pendingPrompts([hosts[0], { ...hosts[1], status: "offline" }], rosters).map(({ host }) => host.serverId), [local]);
});

test("waiting cards appear for open questions and error flags, not for plain finishes, and clear after a reply", () => {
  const erroring = agent({ id: "globex-agent", name: "Other builder", workspaceId: null, requiresAttention: true, attentionReason: "error", attentionTimestamp: "2026-09-28T11:00:00Z", lastError: "Crashed" });
  const finished = agent({ id: "done", requiresAttention: true, attentionReason: "finished", attentionTimestamp: "2026-09-28T11:00:00Z" });
  const rosters = [{ data: { workspaces: [workspace], agents: [agent(), finished] } }, { data: { workspaces: [], agents: [erroring] } }];
  const base = { hosts, rosters, localServerId: local, questions: [question()], taskTitles };
  const cards = waitingCards(base);
  assert.deepEqual(cards.map(card => [card.kind, card.serverId, card.agentId, card.task.title, card.task.place]), [
    ["question", local, "agent-1", "24 · Attention cards that explain themselves", "personal / development-flow / Attention cards"],
    ["error", remote, "globex-agent", "Other builder", "Globex"],
  ]);

  // A reply sent from Attention hides each card at once; the agent's next user message clears it for good.
  assert.deepEqual(waitingCards({ ...base, replied: { [`${local}:agent-1`]: "2026-09-28T10:05:00Z" } }).map(card => card.kind), ["error"]);
  assert.deepEqual(waitingCards({ ...base, replied: { [`${remote}:globex-agent`]: "2026-09-28T11:05:00Z" } }).map(card => card.kind), ["question"]);
  const repliedInChat = [{ data: { workspaces: [workspace], agents: [agent({ lastUserMessageAt: "2026-09-28T10:30:00Z" })] } }, { data: { workspaces: [], agents: [{ ...erroring, lastUserMessageAt: "2026-09-28T11:30:00Z" }] } }];
  assert.deepEqual(waitingCards({ ...base, rosters: repliedInChat }), []);
  // An older reply doesn't hide a newer error, and an answered question isn't listed.
  assert.equal(waitingCards({ ...base, questions: [], replied: { [`${remote}:globex-agent`]: "2026-09-28T10:00:00Z" } }).length, 1);
  assert.deepEqual(waitingCards({ ...base, questions: [question({ status: "answered" })] }).map(card => card.kind), ["error"]);

  // One card per agent: a question beats an error flag, and a pending permission beats both.
  const both = [{ data: { workspaces: [workspace], agents: [agent({ requiresAttention: true, attentionReason: "error", attentionTimestamp: "2026-09-28T10:10:00Z" })] } }, { data: undefined }];
  assert.deepEqual(waitingCards({ ...base, rosters: both }).map(card => card.kind), ["question"]);
  const asking = [{ data: { workspaces: [workspace], agents: [agent({ permissions: [shell] })] } }, { data: undefined }];
  assert.deepEqual(waitingCards({ ...base, rosters: asking }), []);
  // Offline hosts and archived agents show nothing.
  assert.deepEqual(waitingCards({ ...base, hosts: [hosts[0], { ...hosts[1], status: "offline" }] }).map(card => card.kind), ["question"]);
  assert.deepEqual(waitingCards({ ...base, rosters: [{ data: { workspaces: [workspace], agents: [agent({ archivedAt: "2026-09-28T12:00:00Z" })] } }, rosters[1]] }).map(card => card.kind), ["error"]);
});

test("Reply reaches the right agent on the right host", async () => {
  const erroring = agent({ id: "globex-agent", workspaceId: null, requiresAttention: true, attentionReason: "error", attentionTimestamp: "2026-09-28T11:00:00Z" });
  const [asked, failed] = waitingCards({ hosts, rosters: [{ data: { workspaces: [workspace], agents: [agent()] } }, { data: { workspaces: [], agents: [erroring] } }], localServerId: local, questions: [question()], taskTitles });
  const calls = [];
  const deps = {
    replyToQuestion: async input => { calls.push(["question", input]); },
    sendToAgent: async (serverId, agentId, text) => { calls.push(["agent", serverId, agentId, text]); },
  };
  assert.deepEqual(await sendReply(asked, "  With the task. ", deps), replyRoute(asked));
  await sendReply(failed, "Try again with a smaller batch.", deps);
  assert.deepEqual(calls, [
    ["question", { serverId: local, workspaceId: "wks_local", taskId, runId: "run_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", questionId: "question_cccccccc-cccc-4ccc-cccc-cccccccccccc", text: "With the task." }],
    ["agent", remote, "globex-agent", "Try again with a smaller batch."],
  ]);
  await assert.rejects(sendReply(failed, "   ", deps), /Write a reply first/);
  assert.equal(calls.length, 2);
});

test("an agent that asked, was answered in the chat, and then stopped with an error gets its error card", () => {
  // The question record stays open on disk; the chat answer only shows as the agent's later message.
  const answeredThenFailed = agent({ lastUserMessageAt: "2026-09-28T10:30:00Z", requiresAttention: true, attentionReason: "error", attentionTimestamp: "2026-09-28T11:00:00Z", lastError: "Crashed" });
  const cards = waitingCards({ hosts, rosters: [{ data: { workspaces: [workspace], agents: [answeredThenFailed] } }, { data: undefined }], localServerId: local, questions: [question()], taskTitles });
  assert.deepEqual(cards.map(card => [card.kind, card.agentId]), [["error", "agent-1"]]);
  // An unanswered question still stands in for the same agent's error flag.
  const unanswered = { ...answeredThenFailed, lastUserMessageAt: "2026-09-28T09:00:00Z" };
  assert.deepEqual(waitingCards({ hosts, rosters: [{ data: { workspaces: [workspace], agents: [unanswered] } }, { data: undefined }], localServerId: local, questions: [question()], taskTitles }).map(card => card.kind), ["question"]);
});

test("questions don't show, or count, while this host's agent list is loading, failed, or lacks the agent", () => {
  const base = { hosts, localServerId: local, questions: [question()], taskTitles };
  assert.deepEqual(waitingCards({ ...base, rosters: [{ data: undefined }, { data: undefined }] }), [], "loading or failed");
  assert.deepEqual(waitingCards({ ...base, rosters: [] }), [], "no roster yet");
  assert.deepEqual(waitingCards({ ...base, rosters: [{ data: { workspaces: [workspace], agents: [agent({ id: "someone-else" })] } }] }), [], "agent not in the list");
  assert.deepEqual(waitingCards({ ...base, hosts: [{ ...hosts[0], status: "offline" }, hosts[1]], rosters: [{ data: { workspaces: [workspace], agents: [agent()] } }] }), [], "this host offline");
  assert.deepEqual(waitingCards({ ...base, rosters: [{ data: { workspaces: [workspace], agents: [agent()] } }] }).map(card => card.kind), ["question"]);
});

test("the conversation, the chat quote and Wants to hide key-like text, as agent errors do", () => {
  // Built at run time, so the source holds no key-shaped string.
  const key = ["sk", "ant", "api03", "A1b2C3d4".repeat(5)].join("-");
  const steps = conversationSteps([
    { type: "user_message", text: `Use ${key} for this.` },
    { type: "assistant_message", text: `Trying ${key} now.` },
    { type: "tool_call", name: "Bash", status: "failed", detail: { type: "shell", command: `curl -H "Authorization: Bearer ${key}" https://user:pass@example.com/api` } },
    { type: "error", message: `Incorrect API key provided: ${key}` },
    { type: "notification", level: "error", message: `Rejected ${key}` },
  ]);
  assert.equal(steps.length, 5);
  for (const step of steps) {
    assert.ok(!step.text.includes("A1b2C3d4"), step.text);
    assert.match(step.text, /\[key hidden\]/);
  }
  assert.ok(!steps[2].text.includes("user:pass@"), "URL credentials are removed too");
  assert.equal(latestAgentQuote([{ type: "assistant_message", text: `The key ${key} was rejected.` }]), "The key [key hidden] was rejected.");
  assert.match(wantsTo({ ...shell, detail: { type: "shell", command: `export TOKEN=${key}` } }), /^Run a command: export TOKEN=\[key hidden\]$/);
  // Ordinary text is untouched.
  assert.equal(conversationSteps([{ type: "assistant_message", text: "Tests pass." }])[0].text, "Tests pass.");
  // A key the provider already starred out is still recognised: keys are checked before Markdown's ** is stripped.
  const starred = ["sk", "proj", `${"*".repeat(24)}hRkA`].join("-");
  for (const text of [`Incorrect API key provided: ${starred}.`, `**Error:** key ${starred} was rejected.`]) {
    const [step] = conversationSteps([{ type: "assistant_message", text }]);
    assert.ok(!step.text.includes("hRkA") && !step.text.includes("sk-proj"), step.text);
    assert.match(step.text, /\[key hidden\]/);
  }
  assert.equal(conversationSteps([{ type: "assistant_message", text: `**Error:** key ${starred} was rejected.` }])[0].text, "Error: key [key hidden] was rejected.");
});

test("an opened chat is read once, and not again on window focus, reconnect, remount, Refresh or a Reply", async t => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  const client = new QueryClient();
  client.mount();
  t.after(() => { client.unmount(); client.clear(); focusManager.setFocused(undefined); onlineManager.setOnline(true); });
  let reads = 0;
  const observe = key => new QueryObserver(client, { queryKey: key, queryFn: async () => { reads++; return []; }, enabled: true, ...timelineQueryOptions });
  const key = timelineKey(local, "agent-1", "v1");
  const opened = observe(key);
  const stop = opened.subscribe(() => {});
  await settle();
  assert.equal(reads, 1, "opening Conversation reads the chat");

  // Attention's Refresh and a sent Reply invalidate Mission Control's queries; the chat isn't one of them.
  await client.invalidateQueries({ queryKey: ["mission-control"] });
  focusManager.setFocused(false); focusManager.setFocused(true);
  onlineManager.setOnline(false); onlineManager.setOnline(true);
  const remounted = observe(key).subscribe(() => {});
  await settle();
  assert.equal(reads, 1, "nothing reads the chat again by itself");

  // Opening Conversation again reads it again, because the user asked.
  await opened.refetch();
  assert.equal(reads, 2);
  stop(); remounted();

  // Control: the round-4 key and React Query's defaults re-read on Refresh, so this test would have caught them.
  let before = 0;
  const old = new QueryObserver(client, { queryKey: ["mission-control", "timeline", local, "agent-1", "v1"], queryFn: async () => { before++; return []; }, staleTime: 30_000, retry: false });
  const stopOld = old.subscribe(() => {});
  await settle();
  await client.invalidateQueries({ queryKey: ["mission-control"] });
  await settle();
  assert.equal(before, 2);
  stopOld();
});
