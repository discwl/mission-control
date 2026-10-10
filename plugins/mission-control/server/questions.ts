import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { questionSchema, type Question, type QuestionEntry } from "../shared/questions";
import { atomicWrite, inside, markdownRecord, parseRecord, regularFile, withRunLock } from "./decisions";
import type { TaskSource } from "./tasks";

type Ref = { serverId: string; workspaceId: string; taskId: string; runId: string; questionId: string };

const runIdPattern = /^run_[a-f0-9-]+$/;
const questionFilePattern = /^question_[a-f0-9-]+\.md$/;

/** The message an answered question sends to its agent. */
export function replyMessage(question: Question, text: string): string {
  return [
    `Reply from the user in Mission Control to your question ${question.questionId} ("${question.question}"):`,
    text.trim(),
    "This reply grants no new commit, push, merge, or deployment permission.",
  ].join("\n");
}

/** Questions agents recorded with `dev-flow.mjs ask`, read from this host's vault, and the user's replies to them. */
export function createQuestionStore(deps: { sources: (serverId: string) => Promise<TaskSource[]> }) {
  async function runFolderOf(source: TaskSource, runId: string) {
    if (!source.folder || !runIdPattern.test(runId)) throw new Error("Invalid run.");
    const taskFolder = await realpath(source.folder);
    const runs = await realpath(join(taskFolder, "runs"));
    const folder = await realpath(join(runs, runId));
    if (!inside(taskFolder, runs) || !inside(runs, folder)) throw new Error("Run folder escapes the task.");
    return folder;
  }

  async function load(source: TaskSource, runFolder: string, runId: string, name: string) {
    const file = join(runFolder, "questions", name);
    const question = questionSchema.parse(parseRecord(await regularFile(file)).fields);
    const { task } = source;
    if (`${question.questionId}.md` !== name || question.runId !== runId || question.taskId !== task.taskId
      || !task.assignments.some(item => item.serverId === question.serverId && item.workspaceId === question.workspaceId)) {
      throw new Error(`Question ${name} does not match its task and run.`);
    }
    return { question, file };
  }

  async function list(serverId: string): Promise<{ questions: QuestionEntry[]; taskTitles: Record<string, string> }> {
    const sources = await deps.sources(serverId);
    const questions: QuestionEntry[] = [];
    for (const source of sources) {
      if (!source.folder) continue;
      let runNames: string[];
      try { runNames = await readdir(join(source.folder, "runs")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const runId of runNames.filter(name => runIdPattern.test(name))) {
        const runFolder = await runFolderOf(source, runId);
        let names: string[];
        try { names = await readdir(join(runFolder, "questions")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        for (const name of names.filter(value => questionFilePattern.test(value))) {
          const { question } = await load(source, runFolder, runId, name);
          if (question.status === "open") questions.push({ question, taskTitle: source.task.title, projectId: source.task.projectId });
        }
      }
    }
    questions.sort((a, b) => a.question.askedAt.localeCompare(b.question.askedAt));
    return { questions, taskTitles: Object.fromEntries(sources.map(source => [source.task.taskId, source.task.title])) };
  }

  async function reply(input: Ref & { text: string }, paseo: PaseoApi): Promise<{ question: Question }> {
    const source = (await deps.sources(input.serverId)).find(item => item.task.taskId === input.taskId);
    if (!source || !source.task.assignments.some(item => item.serverId === input.serverId && item.workspaceId === input.workspaceId)) {
      throw new Error("Task is not assigned to this workspace.");
    }
    const runFolder = await runFolderOf(source, input.runId);
    const reload = () => load(source, runFolder, input.runId, `${input.questionId}.md`);
    return withRunLock(runFolder, async () => {
    const { question, file } = await reload();
    if (question.status !== "open") throw new Error("This question was already answered or replaced. Refresh Attention.");
    if (question.workspaceId !== input.workspaceId) throw new Error("This question belongs to another workspace.");
    if (question.delivery) throw new Error("A previous reply's delivery is unconfirmed. Open the agent to check; do not resend from this card.");
    let agent;
    try { agent = (await paseo.agents.ref(question.agentId).refresh())?.agent ?? null; }
    catch (error) {
      if (!(error instanceof Error && error.message === `Agent not found: ${question.agentId}`)) throw error;
      agent = null;
    }
    if (!agent || agent.archivedAt || agent.status === "closed") throw new Error("The agent that asked is unavailable or archived. Resume the task from its handoff.");
    if (agent.workspaceId !== question.workspaceId) throw new Error("The agent that asked moved to another workspace.");
    if (agent.lastUserMessageAt && Date.parse(agent.lastUserMessageAt) > Date.parse(question.askedAt)) throw new Error("This question already received a newer message in the agent chat. Refresh Needs you.");
    if (agent.status !== "idle" || agent.activeTurn || agent.pendingPermissions.length) throw new Error("The agent is busy or waiting on a permission. Open it to reply.");
    // Reserve the exact text before sending, under the same lock as the open-state check.
    // If the RPC times out it may have succeeded: leave the receipt for explicit reconciliation.
    await atomicWrite(file, markdownRecord({ ...question, delivery: { text: input.text.trim(), attemptedAt: new Date().toISOString() } }, "# Question"));
    try { await paseo.agents.ref(question.agentId).send(replyMessage(question, input.text), { messageId: question.questionId }); }
    catch { throw new Error("Reply delivery is unconfirmed. Check the agent chat before replying there; this card will not resend automatically."); }
      const answered: Question = { ...question, status: "answered", answeredAt: new Date().toISOString(), answer: input.text.trim(), delivery: null };
      await atomicWrite(file, markdownRecord(answered, "# Question"));
      return { question: answered };
    });
  }

  return { list, reply };
}
