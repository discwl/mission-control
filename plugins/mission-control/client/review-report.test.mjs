import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url), ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { reviewReportModel, findingDiffPath } = require("./review-report-model.ts");
const snapshot = { head: "a".repeat(40), files: [{ path: "src/check.ts" }] };
const fixture = () => ({ task: { taskId: "task-a" }, run: { taskId: "task-a", runId: "run-a", serverId: "host-a", workspaceId: "workspace-a" }, decisions: [{ decision: { decisionId: "review-a", taskId: "task-a", runId: "run-a", serverId: "host-a", workspaceId: "workspace-a", kind: "review", status: "open", requestedAt: "2026-10-30T10:00:00Z", gitHead: snapshot.head }, findings: [], summary: "Full authored report" }] });
const model = (entry = fixture(), live = snapshot, stale = false, events = []) => reviewReportModel(entry, "host-a", "workspace-a", live, stale, events);
const event = (extra = {}) => ({ taskId: "task-a", runId: "run-a", serverId: "host-a", workspaceId: "workspace-a", stage: "validate", at: "2026-10-30T09:00:00Z", gitHead: snapshot.head, body: "Checks and limitations", ...extra });

test("only the current task, run, host and workspace can supply a review or its controls", () => {
  assert.equal(model().canDecide, true);
  for (const field of ["taskId", "runId", "serverId", "workspaceId"]) {
    const entry = fixture(); entry.decisions[0].decision[field] = "foreign";
    assert.equal(model(entry).review, null, field);
    assert.equal(model(entry).canDecide, false, field);
  }
  for (const field of ["taskId", "serverId", "workspaceId"]) {
    const entry = fixture(); entry.run[field] = "foreign";
    assert.equal(model(entry).review, null, `run ${field}`);
  }
  const entry = fixture(); entry.run = null;
  assert.equal(model(entry).review, null);
});
test("a newer resolved request never falls back to an older open approval", () => {
  const entry = fixture();
  entry.decisions.push({ ...entry.decisions[0], decision: { ...entry.decisions[0].decision, decisionId: "review-b", requestedAt: "2026-10-30T11:00:00Z", status: "approved" } });
  assert.equal(model(entry).review.decision.decisionId, "review-b");
  assert.equal(model(entry).canDecide, false);
});
test("missing snapshot, changed commit, stale data and later implementation suppress decision controls", () => {
  assert.equal(model(fixture(), null).canDecide, false);
  assert.equal(model(fixture(), { ...snapshot, head: "b".repeat(40) }).canDecide, false);
  assert.equal(model(fixture(), snapshot, true).canDecide, false);
  assert.equal(model(fixture(), snapshot, false, [event({ stage: "fix", at: "2026-10-30T11:00:00Z" })]).canDecide, false);
  assert.match(model().warning, /exact candidate again/);
});
test("unresolved findings precede resolved findings and foreign decision findings are excluded", () => {
  const entry = fixture();
  entry.decisions[0].findings = [
    { findingId: "fixed", decisionId: "review-a", severity: "high", status: "resolved" },
    { findingId: "low", decisionId: "review-a", severity: "low", status: "open" },
    { findingId: "high", decisionId: "review-a", severity: "high", status: "awaiting_verification" },
    { findingId: "foreign", decisionId: "review-other", severity: "high", status: "open" },
  ];
  assert.deepEqual(model(entry).findings.map(f => f.findingId), ["high", "low", "fixed"]);
});
test("validation comes only from the owning run and later fixes mark its results stale", () => {
  for (const field of ["taskId", "runId", "serverId", "workspaceId"]) assert.equal(model(fixture(), snapshot, false, [event({ [field]: "foreign" })]).validation, null, field);
  assert.equal(model(fixture(), snapshot, false, [event()]).validation.body, "Checks and limitations");
  assert.equal(model(fixture(), snapshot, false, [event(), event({ stage: "fix", at: "2026-10-30T09:30:00Z" })]).validationStale, true);
  assert.equal(model(fixture(), snapshot, false, [event({ gitHead: null })]).validationStale, true);
});
test("file links resolve only to an exact path in the displayed diff, never a basename match", () => {
  assert.equal(findingDiffPath("src\\check.ts:12:3", snapshot), "src/check.ts");
  assert.equal(findingDiffPath("src/check.ts#L12-L20", snapshot), "src/check.ts");
  assert.equal(findingDiffPath("check.ts", snapshot), null);
  assert.equal(findingDiffPath("../src/check.ts", snapshot), null);
  assert.equal(findingDiffPath("C:/other/src/check.ts", snapshot), null);
});

test("finding navigation reveals a file excluded by the active comparison filter", () => {
  const source = ts.createSourceFile("mission-review.tsx", readFileSync(new URL("./mission-review.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let select;
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === "select") select = node; ts.forEachChild(node, visit); }
  visit(source); assert.ok(select, "exercise the actual diff navigation callback");
  const code = ts.transpileModule(select.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const files = [{ path: "src/other.ts" }, { path: "src/finding.ts" }];
  const state = { comparisonPaths: ["src/other.ts"], selectedPath: "src/other.ts", filter: "high" };
  const navigate = new Function("comparisonPaths", "setComparisonPaths", "setFilter", "setWorkingFile", "setSelectedPath", "setBlockIndex", "setShowDetail", "setPane", `${code}; return select;`)(
    state.comparisonPaths, value => state.comparisonPaths = value, value => state.filter = value, () => {}, value => state.selectedPath = value, () => {}, () => {}, () => {},
  );
  navigate("src/finding.ts");
  const displayed = files.find(file => file.path === state.selectedPath && (!state.comparisonPaths || state.comparisonPaths.includes(file.path)));
  assert.equal(displayed?.path, "src/finding.ts");
  assert.equal(state.filter, "all");
});

function renderReport(entry, stale = false) {
  const calls = [], nodes = [], queries = [];
  const docs = [{ name: "runs/run-a/review.md", content: "Full referenced report\n".repeat(100), revision: "doc-v1", updatedAt: "2026-10-30T10:00:00Z", editable: false }];
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const imports = {
    "react": { useState: value => [value, () => {}] },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { Text: "Text", View: "View" },
    "@tanstack/react-query": { useQuery: options => { queries.push(options); return { data: { documents: docs }, isPending: false, isError: false }; } },
    "../shared/tasks": { listTaskDocuments: "documents" },
    "./host-rpc": { useRpc: () => input => calls.push(input) },
    "./compact-link": { CompactLink: "Link" },
    "./decision-card": { DecisionCard: "DecisionCard" },
    "./markdown-preview": { MarkdownPreview: "MarkdownPreview" },
    "./task-flow-content": { ArtifactCard: "ArtifactCard" },
    "./task-flow-model": { recentActivity: () => ({ events: [], issues: [] }) },
    "./task-flow-presentation": require("./task-flow-presentation.ts"),
    "./review-report-model": { reviewReportModel, findingDiffPath },
    "./date-time": { formatDateTime: value => value },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./review-report.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", compiled)(name => { if (name in imports) return imports[name]; throw Error(name); }, loaded, loaded.exports);
  const tree = loaded.exports.ReviewReport({ entry, serverId: "host-a", workspace: { id: "workspace-a", name: "Workspace", projectName: "Project", hostLabel: "Host" }, snapshot, stale, colors: {}, selectFile: path => calls.push({ path }), openAgent: agentId => calls.push({ agentId }), onEvidence() {} });
  function walk(node) { if (Array.isArray(node)) node.forEach(walk); else if (node && typeof node === "object") { nodes.push(node); walk(node.props?.children); } }
  walk(tree);
  return { calls, nodes, queries, docs };
}
test("rendered report keeps full authored text and exact referenced documents beside the original guarded decision", async () => {
  const entry = fixture();
  entry.summary = "Long review report\n".repeat(100);
  entry.decisions[0].summary = entry.summary;
  entry.decisions[0].unverifiedFindings = 0;
  entry.decisions[0].decision.evidence = ["runs/run-a/review.md", "C:/vault/Tasks/task-foreign/runs/run-a/review.md"];
  const rendered = renderReport(entry);
  assert.equal(rendered.nodes.find(n => n.type === "MarkdownPreview").props.content, entry.summary);
  const artifacts = rendered.nodes.filter(n => n.type === "ArtifactCard");
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].props.document.content, rendered.docs[0].content);
  const decision = rendered.nodes.find(n => n.type === "DecisionCard");
  assert.equal(decision.props.entry, entry.decisions[0]);
  assert.equal(decision.props.serverId, "host-a");
  assert.equal(rendered.calls.length, 0, "render never sends decisions or opens agents");
  await rendered.queries[0].queryFn();
  assert.deepEqual(rendered.calls, [{ serverId: "host-a", workspaceId: "workspace-a", taskId: "task-a" }]);
});
test("stale rendered review retains its report but never mounts decision controls", () => {
  const entry = fixture(); entry.decisions[0].decision.evidence = [];
  const rendered = renderReport(entry, true);
  assert.ok(rendered.nodes.some(n => n.type === "MarkdownPreview"));
  assert.equal(rendered.nodes.some(n => n.type === "DecisionCard"), false);
  assert.equal(rendered.calls.length, 0);
});
