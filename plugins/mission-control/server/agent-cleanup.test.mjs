import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createAgentCleanupEngine } from "./agent-cleanup-engine.ts";
const require = createRequire(import.meta.url);
const ts = require("typescript"), z = require("zod").z;
const compile = url => ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function load(code, imports, globals = {}) {
  const module = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), code)(id => id in imports ? imports[id] : require(id), module, module.exports, ...Object.values(globals));
  return module.exports;
}
const contracts = load(compile(new URL("../shared/agent-cleanup.ts", import.meta.url)), {
  "@getpaseo/plugin": { defineRpc: value => value, defineSettings: value => value },
  "./pull-request": { trackedPullRequestSchema: z.object({}).passthrough() },
});
const serverCode = compile(new URL("./agent-cleanup.ts", import.meta.url));
const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
const scope = { serverId: "test-host", workspaceId: "test-workspace" };
const agent = (extra = {}) => ({ id: "test-agent", title: "Synthetic conversation", workspaceId: scope.workspaceId, status: "idle", createdAt: old, updatedAt: old, lastUserMessageAt: old, archivedAt: null, activeTurn: null, pendingPermissions: [], requiresAttention: false, providerUnavailable: false, labels: {}, ...extra });
function runtime(options = {}) {
  const files = options.files ?? new Map(), handlers = new Map(), calls = [];
  let agents = [agent(options.agent)], pages = 0;
  const fs = {
    async readFile(path) { if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return files.get(path); },
    async mkdir() {}, async writeFile(path, value) { files.set(path, value); },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
  };
  const task = { taskId: "test-task", title: "Synthetic delivered task", status: "delivered", updatedAt: old, assignments: [{ serverId: scope.serverId, workspaceId: scope.workspaceId }] };
  const exports = load(serverCode, {
    "node:fs/promises": fs, "../shared/agent-cleanup": contracts, "./agent-cleanup-engine": { createAgentCleanupEngine },
    "./agent-names": { daemonServerId: async () => scope.serverId }, "./tasks": { localServerId: async () => scope.serverId, scanTaskSources: async () => ({ sources: [{ task }], problems: options.problems ?? [] }) },
    "./runs": { runRecordsOf: async () => [{ agentId: "test-agent", updatedAt: old }] },
    "./subagents": { createHelperService: () => ({ list: async () => ({ available: options.helpersAvailable !== false, helpers: options.helpers ?? [] }) }) },
  }, { process: { env: { PASEO_HOME: "virtual-cleanup-test" } } });
  const paseo = {
    agents: {
      async list(input) {
        pages++; calls.push({ action: "list", input });
        if (options.resumeBeforeArchive && pages === 3) agents[0] = { ...agents[0], status: "running", activeTurn: { id: "synthetic-turn" } };
        return { entries: agents.filter(item => input.filter.includeArchived || !item.archivedAt).map(agent => ({ agent })), pageInfo: { hasMore: options.incomplete === true, nextCursor: null } };
      },
      ref(id) { return {
        timeline: { async refetch() { calls.push({ action: "timeline", id }); if (options.timelineError) throw new Error("unavailable"); return { entries: options.timeline ?? [{ timestamp: old, item: { type: "assistant_message" } }] }; } },
        async archive() { calls.push({ action: "archive", id }); const archivedAt = new Date().toISOString(); agents = agents.map(item => item.id === id ? { ...item, archivedAt } : item); return { archivedAt }; },
      }; },
    },
    workspaces: { list: async () => ({ entries: [{ id: scope.workspaceId, pinnedAt: null }], pageInfo: { hasMore: false } }) },
  };
  exports.registerAgentCleanup({ registerSettings: () => ({ read: async () => ({ status: "ready", values: { deliveredDays: 7, unlinkedDays: 14 } }) }), handle: (contract, handler) => handlers.set(contract.name, { contract, handler }) }, {
    decisions: { list: async () => ({ open: options.decisions ?? [] }) }, questions: { list: async () => ({ questions: [] }) }, pullRequests: { list: async () => ({ pullRequests: [] }) },
  });
  const invoke = async (name, input) => { const { contract, handler } = handlers.get(name); return contract.output.parse(await handler(contract.input.parse(input), { paseo })); };
  return { invoke, calls, files, paseo, activity: exports.cleanupActivity };
}

test("host scan is read-only and recent metadata does not replace actual conversation activity", async () => {
  const r = runtime({ agent: { updatedAt: new Date().toISOString() } });
  const scan = await r.invoke("agents.cleanup.scan", scope);
  assert.equal(scan.rows[0].disposition, "eligible"); assert.equal(scan.rows[0].activityBasis, "conversation");
  assert.equal(r.calls.filter(call => call.action === "archive").length, 0); assert.equal(r.files.size, 0);
});
test("stopped or unavailable agents are not awakened by reading their timelines", async () => {
  for (const extra of [{ status: "closed" }, { status: "error" }, { providerUnavailable: true }, { activeTurn: { id: "turn" } }, { pendingPermissions: [{ id: "request" }] }, { archivedAt: old }]) {
    const r = runtime(); await r.activity(r.paseo, agent(extra)); assert.equal(r.calls.length, 0);
  }
});
test("stopped-agent bounds include the latest prompt, and invalid bounds stay unknown", async () => {
  const r = runtime(); const recent = new Date().toISOString();
  assert.equal((await r.activity(r.paseo, agent({ status: "closed", lastUserMessageAt: recent }))).at, recent);
  assert.equal((await r.activity(r.paseo, agent({ status: "closed", updatedAt: "invalid" }))).at, null);
});
test("unreadable task records and unavailable helper checks prevent eligibility", async () => {
  for (const options of [{ problems: [{ file: "synthetic-task.md", problem: "invalid" }] }, { helpersAvailable: false }, { timelineError: true }]) {
    const scan = await runtime(options).invoke("agents.cleanup.scan", scope);
    assert.equal(scan.rows[0].disposition, "unknown");
  }
});
test("running internal helpers and task-only decisions keep the family", async () => {
  for (const options of [{ helpers: [{ status: "running" }] }, { decisions: [{ decision: { taskId: "test-task", agentId: null } }] }]) {
    const scan = await runtime(options).invoke("agents.cleanup.scan", scope); assert.equal(scan.rows[0].disposition, "keep");
  }
});
test("incomplete directories and another host fail before any archive", async () => {
  const incomplete = runtime({ incomplete: true }); await assert.rejects(incomplete.invoke("agents.cleanup.scan", scope), /directory is incomplete/);
  const foreign = runtime(); await assert.rejects(foreign.invoke("agents.cleanup.scan", { ...scope, serverId: "another-host" }), /host/i); assert.equal(foreign.calls.length, 0);
});
test("the final directory check refuses a family that resumes after the preview recheck", async () => {
  const r = runtime({ resumeBeforeArchive: true }), scan = await r.invoke("agents.cleanup.scan", scope);
  const result = await r.invoke("agents.cleanup.archive", { ...scope, scanId: scan.scanId, agentIds: ["test-agent"] });
  assert.equal(result.results[0].outcome, "failed"); assert.match(result.results[0].detail, /family changed/i);
  assert.equal(r.calls.filter(call => call.action === "archive").length, 0);
});
test("confirmed synthetic cleanup records receipts that survive registering the plugin again", async () => {
  const r = runtime(), scan = await r.invoke("agents.cleanup.scan", scope);
  const result = await r.invoke("agents.cleanup.archive", { ...scope, scanId: scan.scanId, agentIds: ["test-agent"] });
  assert.equal(result.results[0].outcome, "archived"); assert.deepEqual(result.results[0].archivedIds, ["test-agent"]);
  const history = await runtime({ files: r.files }).invoke("agents.cleanup.history", scope);
  assert.deepEqual(history.entries.map(entry => entry.outcome), ["archived", "started"]);
});
