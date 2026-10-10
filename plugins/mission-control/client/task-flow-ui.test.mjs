import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
const taskId = "task_abc", at = "2026-09-29T12:00:00Z";
const metadata = { schemaVersion: 1, taskId, runId: "run_bbb", eventId: "event_aaa", agentId: "author", stage: "review", outcome: "completed", at, evidence: ["report.md", "git status: clean"], gitHead: null, gitDirty: false, gitChanges: [], omittedChanges: 0 };
const document = (name, content) => ({ name, content, updatedAt: at, revision: "r1", editable: true });
const documents = [document("report.md", "---\nrevision: 1\n---\n# Report\nActual report"), document("runs/run_bbb/events/event_aaa.md", "---\n" + Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n") + "\n---\n# review: completed\nActual review summary")];
function harness(online = true, rosterAgents, fetchedAgents = []) {
 const states = new Map(), modules = new Map(), opened = [];
 let path, cursor, root, tree, reads = 0;
 const jsx = (type, props) => ({ type, props });
 const useState = initial => { const key = `${path}:${cursor++}`; if (!states.has(key)) states.set(key, initial); return [states.get(key), value => states.set(key, typeof value === "function" ? value(states.get(key)) : value)]; };
 function load(file) {
  if (modules.has(file)) return modules.get(file);
  const exports = {}; modules.set(file, exports);
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => {
   if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
   if (name === "react") return { useState };
   if (name === "react-native") return { View: "View", Text: "Text", Pressable: "Pressable", Platform: { OS: "web" } };
   if (name === "@getpaseo/plugin/client/react-native") return { Icon: "Icon" };
   if (name === "@getpaseo/plugin/client" || name === "./host-rpc") return { useRpc: () => async () => ({}), useWorkspace: () => { throw Error("Panel-only hook"); } };
   if (name === "@tanstack/react-query") return { useQuery: options => { if (options.queryKey.includes("flow-documents")) { reads++; return { data: { documents }, isSuccess: true }; } if (options.queryKey.includes("recorded-agents")) return { data: fetchedAgents, isSuccess: true, isFetching: false }; return { data: { runs: [] }, isSuccess: true }; } };
   if (name === "./roster") return { useRoster: () => ({ data: { agents: rosterAgents ?? [{ id: "author", name: "Reviewer", status: "idle", taskId }, { id: "builder", name: "Builder", status: "running", taskId }, { id: "other", name: "Unrelated", status: "running", taskId: "task_other" }] } }) };
   if (name === "./needs-you") return { useDecisions: () => ({ data: { open: [], recent: [] }, isSuccess: true }) };
   if (name === "./date-time") return { formatDateTime: value => value };
   if (name === "./document-links") return { DocumentLinkText: ({ link }) => jsx("Text", { children: link.label }) };
   if (["./task-flow-model", "./task-flow-presentation", "./document-link-model"].includes(name)) return load(name + ".ts");
   if (["./task-flow-content", "./markdown-preview", "./compact-link"].includes(name)) return load(name + ".tsx");
   return {};
  } }); return exports;
 }
 function render(node, location = "root") {
  if (Array.isArray(node)) return node.map((value, index) => render(value, `${location}:${index}`));
  if (!node || typeof node !== "object") return node;
  if (typeof node.type === "function") { path = location; cursor = 0; return render(node.type(node.props), location + ":body"); }
  return { ...node, props: { ...node.props, children: render(node.props?.children, location + ":children") } };
 }
 const text = node => Array.isArray(node) ? node.map(text).join(" ") : node && typeof node === "object" ? text(node.props.children) : typeof node === "string" || typeof node === "number" ? String(node) : "";
 const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...nodes(node.props.children)] : [];
 function mount(Component, extra = {}) { root = jsx(Component, { task: { taskId, title: "Task A", status: "in_review", updatedAt: at }, binding: { taskId, serverId: "host", workspaceId: "workspace" }, online, colors: {}, hostLabel: "Host", openAgent: id => opened.push(id), ...extra }); tree = render(root); }
 function press(label) { const node = nodes(tree).find(node => node.type === "Pressable" && (node.props.accessibilityLabel === label || text(node) === label)); assert.ok(node, `Missing ${label}`); node.props.onPress(); tree = render(root); }
 return { load, mount, press, text: () => text(tree), nodes: () => nodes(tree), opened, reads: () => reads };
}
test("details show recorded authors, multiple linked agents and readable summaries", () => {
 const h = harness(); h.mount(h.load("./task-flow.tsx").TaskFlowDetail);
 assert.doesNotMatch(h.text(), /Actual review summary|Recorded by Reviewer/);
 assert.match(h.text(), /Review completed/);
 assert.equal(h.nodes().find(node => node.props.accessibilityLabel === "Review completed").props.accessibilityState.expanded, false);
 assert.ok(h.nodes().some(node => node.type === "Icon" && node.props.name === "SquareCheck"));
 h.press("Review completed");
 assert.match(h.text(), /Actual review summary/); assert.match(h.text(), /Recorded by Reviewer/); assert.match(h.text(), /Builder/);
 assert.doesNotMatch(h.text(), /Unrelated|event_aaa|run_bbb|task_abc/);
 h.press("Open author Reviewer"); assert.deepEqual(h.opened, ["author"]);
 h.press("Evidence · 2"); assert.match(h.text(), /git status: clean/); assert.doesNotMatch(h.text(), /Evidence unavailable/);
 h.press("Report"); assert.match(h.text(), /Actual report/); assert.doesNotMatch(h.text(), /revision: 1/);
 h.press("Raw source"); assert.match(h.text(), /revision: 1/);
});
test("activity disclosure hides long prose and duplicated evidence until requested", () => {
 const h = harness();
 const event = { ...h.load("./task-flow-model.ts").recentActivity(documents, taskId).events[0], body: "# review: completed\nLong recorded summary.\n\n## Next action\nRead the report.\n\n## Evidence\n- report.md\n- git status: clean" };
 h.mount(h.load("./task-flow-content.tsx").ActivityEntry, { event, documents, events: [event], taskId, serverId: "host", openDocument: () => {} });
 assert.doesNotMatch(h.text(), /Long recorded summary|Read the report|git status: clean/);
 h.press("Review completed");
 assert.match(h.text(), /Long recorded summary|Read the report/);
 assert.doesNotMatch(h.text(), /git status: clean/);
 h.press("Evidence · 2"); assert.match(h.text(), /git status: clean/);
 h.press("Review completed"); assert.doesNotMatch(h.text(), /Long recorded summary|Evidence · 2/);
 assert.equal(h.nodes().find(node => node.props.accessibilityLabel === "Review completed").props.accessibilityState.expanded, false);
});
test("waiting, blocked and in-progress activity have distinct titles and never a completion check", () => {
 for (const [outcome, title, icon] of [["waiting", "Review waiting", "CirclePause"], ["blocked", "Review blocked", "TriangleAlert"], ["in_progress", "Review in progress", "CirclePlay"]]) {
  const h = harness(), event = { ...h.load("./task-flow-model.ts").recentActivity(documents, taskId).events[0], outcome };
  h.mount(h.load("./task-flow-content.tsx").ActivityEntry, { event, documents, events: [event], taskId, serverId: "host", openDocument: () => {} });
  assert.match(h.text(), new RegExp(title));
  assert.ok(h.nodes().some(node => node.type === "Icon" && node.props.name === icon));
  assert.ok(!h.nodes().some(node => node.type === "Icon" && node.props.name === "SquareCheck"));
 }
});
test("row expansion loads activity without navigating; full details is a separate action", () => {
 const h = harness(); let opened = 0; h.mount(h.load("./task-flow.tsx").TaskFlowRow, { selected: false, onPress: () => opened++ });
 assert.equal(h.reads(), 0); h.press("Activity for Task A"); assert.equal(h.reads(), 1); assert.equal(opened, 0); assert.match(h.text(), /Actual review summary/);
 h.press("View full details for Task A"); assert.equal(opened, 1); h.press("Activity for Task A"); assert.doesNotMatch(h.text(), /Actual review summary/);
});
test("recorded agents missing from the directory still appear and open", () => {
 const h = harness(true, []);
 h.mount(h.load("./task-flow-content.tsx").TaskAgents, { taskId, serverId: "host", runs: [], events: [{ agentId: "missing-agent-id" }], openAgent: id => h.opened.push(id) });
 assert.match(h.text(), /Agents ·\s+1/);
 assert.match(h.text(), /Recorded agent · missing-/);
 h.press("Open agent Recorded agent · missing-");
 assert.deepEqual(h.opened, ["missing-agent-id"]);
});
test("a recorded agent fetched by ID shows its name", () => {
 const h = harness(true, [], [{ id: "missing-agent-id", name: "Archived Builder", status: "idle", parentAgentId: null }]);
 h.mount(h.load("./task-flow-content.tsx").TaskAgents, { taskId, serverId: "host", runs: [], events: [{ agentId: "missing-agent-id" }], openAgent: id => h.opened.push(id) });
 assert.match(h.text(), /Agents ·\s+1.*Archived Builder/);
 assert.doesNotMatch(h.text(), /Details unavailable/);
 h.press("Open agent Archived Builder");
 assert.deepEqual(h.opened, ["missing-agent-id"]);
});
test("offline records retain stale agent states and disable agent navigation", () => {
 const h = harness(false); h.mount(h.load("./task-flow.tsx").TaskFlowDetail);
 assert.match(h.text(), /Last observed: running/); assert.match(h.text(), /Host offline/);
 assert.ok(!h.nodes().some(node => node.props.accessibilityLabel === "Open author Reviewer"));
});
