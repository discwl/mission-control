import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url), ts = require("typescript"), z = require("zod").z;
const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function load(code, imports) {
  const module = { exports: {} };
  new Function("require", "module", "exports", "setInterval", "clearInterval", code)(id => { if (id in imports) return imports[id]; throw new Error(`Unexpected import ${id}`); }, module, module.exports, () => 1, () => {});
  return module.exports;
}
const contracts = load(compile("../shared/agent-cleanup.ts"), { "@getpaseo/plugin": { defineRpc: value => value, defineSettings: value => value }, zod: { z }, "./pull-request": { trackedPullRequestSchema: z.object({}).passthrough() } });
const codes = { cleanup: compile("./agent-cleanup.tsx"), tree: compile("./agent-tree.tsx"), link: compile("./compact-link.tsx") };
const colors = { foreground: "fg", foregroundMuted: "muted", border: "border", accent: "accent", accentForeground: "on-accent", surface1: "surface1", surface2: "surface2", statusWarning: "warning", statusDanger: "danger", statusSuccess: "success" };
const scope = { serverId: "test-host", workspaceId: "test-workspace" };
const row = (agentId, title, extra = {}) => ({ agentId, title, disposition: "eligible", reason: "Finished and inactive", lastActivityAt: new Date().toISOString(), activityBasis: "conversation", taskTitles: ["Synthetic task"], archiveIds: [agentId], detachedIds: [], untouchedIds: [], manualOnly: false, ...extra });
const preview = () => ({ scanId: "scan-1", ...scope, scannedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(), policy: { deliveredDays: 7, unlinkedDays: 14 }, rows: [row("finished", "Finished"), row("unlinked", "Unlinked", { manualOnly: true, taskTitles: [] }), row("kept", "Kept", { disposition: "keep" }), row("unknown", "Unknown", { disposition: "unknown" })], warnings: [], mergedPullRequests: [] });
function runtime(options = {}) {
  const state = [], effects = [], nodes = [], calls = [], queries = [], invalidations = [], saves = [];
  let index = 0, pending = Promise.resolve(), scanData = preview();
  const props = { scope: { ...scope }, colors, online: true, onClose: () => calls.push({ name: "close" }) };
  let agents = [{ id: "synthetic-agent", name: "Synthetic agent", workspaceId: scope.workspaceId, permissions: [] }];
  const roster = { data: { agents, outsideParents: [], workspaces: [{ id: scope.workspaceId, name: "Test workspace", projectName: "Test project" }] }, isFetching: false, isError: false, refetch: async () => {} };
  const previewQuery = { get data() { return scanData; }, isFetching: false, isPending: false, isError: false, refetch: async () => { calls.push({ name: "rescan" }); scanData = { ...scanData, scanId: "scan-2" }; return { data: scanData }; } };
  const settings = { status: "ready", values: contracts.agentCleanupSettings.schema.parse({}), revision: "revision-1", saving: false, saveError: null, save: async (values, revision) => { saves.push({ values, revision }); return true; } };
  const mutation = { isPending: false, isError: false, error: null, data: null, reset() { mutation.isError = false; mutation.error = null; mutation.data = null; }, mutate: null };
  const jsx = (type, props, key) => ({ type, props, key });
  const react = {
    useState(initial) { const slot = index++; if (!(slot in state)) state[slot] = typeof initial === "function" ? initial() : initial; return [state[slot], value => { state[slot] = typeof value === "function" ? value(state[slot]) : value; }]; },
    useRef(initial) { const slot = index++; return state[slot] ??= { current: initial }; },
    useMemo: fn => fn(),
    useEffect(effect, deps) { const slot = index++, prior = state[slot]; if (!prior || deps.some((value, i) => !Object.is(value, prior[i]))) { state[slot] = deps; effects.push(effect); } },
  };
  const common = {
    react, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { Pressable: "Pressable", Text: "Text", TextInput: "TextInput", View: "View", ScrollView: "ScrollView", ActivityIndicator: "ActivityIndicator", Platform: { OS: "web" } },
    "@getpaseo/plugin/client/react-native": { Icon: "Icon", useToast: () => ({}) },
    "@getpaseo/plugin/client": { useHosts: () => [{ serverId: props.scope.serverId, label: "Test host", status: "online" }], getPaseoClient: () => { throw new Error("No live client allowed"); }, useSettings: () => settings, useRpc: contract => async input => { calls.push({ name: contract.name, input }); if (contract.name === "agents.cleanup.scan") return scanData; if (options.execute) return options.execute(input); return { results: [{ agentId: input.agentIds[0], title: "Finished", outcome: "skipped", detail: "Task reopened", archivedIds: [] }] }; } },
    "@tanstack/react-query": {
      useQuery(query) { queries.push(query); if (query.queryKey[0] === "roster") return roster; if (query.queryKey.includes("agent-runs")) return { data: { runs: {} } }; if (query.queryKey.includes("agent-cleanup-history")) return { data: { entries: [] }, isPending: false }; return previewQuery; },
      useQueryClient: () => ({ invalidateQueries: async input => { invalidations.push(input.queryKey); } }),
      useMutation(config) { mutation.mutate = () => { mutation.isPending = true; pending = Promise.resolve().then(config.mutationFn).then(value => { mutation.data = value; }, error => { mutation.isError = true; mutation.error = error; }).finally(() => { mutation.isPending = false; config.onSettled(); }); }; return mutation; },
    },
  };
  const { CompactLink } = load(codes.link, common);
  const cleanup = load(codes.cleanup, { ...common, "../shared/agent-cleanup": contracts, "./app-modal": { AppModal: Object.assign("AppModal", { Content: "ModalContent" }) }, "./pull-request-action": { CleanupDialog: "DeliveryCleanupDialog" }, "./roster": { rosterKey: id => ["roster", id] }, "./date-time": { formatDateTime: value => value } });
  const states = ["needs-input", "failed", "working", "ready", "idle", "closed"];
  const tree = load(codes.tree, { ...common,
    "./compact-link": { CompactLink }, "./app-modal": { AppModal: Object.assign("AppModal", { Content: "ModalContent" }) },
    "../shared/agent-tree": { AGENT_STATES: states, AGENT_STATE_LABELS: Object.fromEntries(states.map(value => [value, value])), buildAgentTree: items => items.map(agent => ({ kind: "agent", agent, member: true })), summarizeTree: items => ({ agents: items.length, helpers: 0, counts: Object.fromEntries(states.map(value => [value, 0])) }), collapseTree: value => value, waitingByAgent: () => new Map(), nodeKey: node => node.agent.id },
    "../shared/agents-panel": { listAgentRuns: { name: "runs" } }, "./attention-card": { useWaiting: () => ({ data: { questions: [] } }) }, "./attention-model": { waitingCards: () => [] },
    "./date-time": { formatDateTime: value => value }, "./live-roster": { LIVE_BACKSTOP_MS: 30_000 }, "./needs-you": { useDecisions: () => ({ data: { open: [] } }) },
    "./permissions": { PermissionCard: "PermissionCard" }, "./provider-icons": { ProviderIcon: "ProviderIcon" }, "./roster": { useLiveRoster: () => {}, rosterQuery: () => ({ queryKey: ["roster"] }) }, "../shared/subagents": {}, "./info-tip": { InfoTip: "InfoTip" },
    "./review-names": { RenameAgents: "RenameAgents" }, "./agent-cleanup": cleanup, "./subagents": { useHelpers: () => [], useTaskTitles: () => ({}) },
  });
  function visit(node) { if (!node || typeof node !== "object") return; if (Array.isArray(node)) return node.forEach(visit); nodes.push(node); visit(node.props?.children); }
  function render(kind = "dialog") {
    index = 0; nodes.length = 0; effects.length = 0;
    let element;
    if (kind === "settings") { const wrapper = cleanup.AgentCleanupSettings({ host: { id: props.scope.serverId }, theme: { colors } }); element = wrapper.type(wrapper.props); }
    else if (kind === "tree") element = tree.AgentTree({ ...scope, serverId: props.scope.serverId, localServerId: scope.serverId, online: props.online, colors, canNavigate: true, openAgent: () => {}, heading: (_summary, controls) => jsx("View", { children: [controls.renameAll, jsx(CompactLink, { label: "Refresh", colors, onPress: controls.refresh })] }) });
    else element = cleanup.AgentCleanupDialog(props);
    visit(element); effects.forEach(effect => effect()); return nodes;
  }
  const button = label => { const found = nodes.find(node => node.props?.accessibilityLabel === label || node.props?.label === label); assert.ok(found, `Missing ${label}`); return found; };
  const checkbox = title => { const found = nodes.find(node => node.props?.accessibilityRole === "checkbox" && node.props.accessibilityLabel.startsWith(`${title}:`)); assert.ok(found); return found.props; };
  return { render, button, checkbox, nodes, props, settings, calls, queries, invalidations, saves, mutation, CompactLink, cleanup, wait: () => pending, setPreview: value => { scanData = value; }, setAgents: value => { agents = value; roster.data.agents = value; }, text: () => JSON.stringify(nodes.map(node => node.props?.children)) };
}

test("the header broom uses the pencil/refresh button component and opens only a preview", () => {
  const r = runtime(); r.render("tree");
  const broom = r.button("Check cleanup for this workspace's agents"), refresh = r.button("Refresh");
  assert.equal(broom.type, refresh.type); assert.equal(broom.type, r.CompactLink); assert.equal(broom.props.iconOnly, true);
  const rendered = broom.type(broom.props), style = rendered.props.style({ pressed: false });
  assert.equal(style.borderWidth, 1); assert.equal(style.borderColor, colors.border);
  assert.equal(style.minHeight, 32); assert.equal(rendered.props.accessibilityRole, "button");
  broom.props.onPress(); r.render("tree");
  assert.ok(r.nodes.some(node => node.type === r.cleanup.AgentCleanupDialog)); assert.equal(r.calls.length, 0);
  r.setAgents([]); r.render("tree"); assert.ok(r.nodes.some(node => node.type === r.cleanup.AgentCleanupDialog), "results survive the archived row disappearing");
});
test("preview starts unselected and batch selection excludes unlinked conversations", async () => {
  const r = runtime(); r.render();
  assert.equal(r.button("Archive selected (0)").props.disabled, true); assert.equal(r.checkbox("Finished").accessibilityState.checked, false);
  await r.queries[0].queryFn(); assert.deepEqual(r.calls[0], { name: "agents.cleanup.scan", input: scope });
  r.button("Select finished task families").props.onPress(); r.render();
  assert.equal(r.checkbox("Finished").accessibilityState.checked, true); assert.equal(r.checkbox("Unlinked").accessibilityState.checked, false);
  assert.equal(r.calls.filter(call => call.name === "agents.cleanup.archive").length, 0);
});
test("explicit checkbox selection submits the exact host, workspace, family and preview once", async () => {
  const r = runtime(); r.props.scope.agentId = "family-root"; r.render();
  r.checkbox("Unlinked").onPress(); r.render();
  const action = r.button("Archive selected (1)").props; action.onPress(); action.onPress(); await r.wait(); r.render();
  const calls = r.calls.filter(call => call.name === "agents.cleanup.archive"); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, { ...scope, agentId: "family-root", scanId: "scan-1", agentIds: ["unlinked"] });
  assert.match(r.text(), /Task reopened/); assert.ok(!r.nodes.some(node => node.props?.accessibilityLabel?.startsWith("Archive selected")));
  assert.deepEqual(r.invalidations[0], ["roster", scope.serverId]);
});
test("expired or offline previews cannot archive even if their handler is invoked", async () => {
  for (const mode of ["expired", "offline"]) {
    const r = runtime(); r.render(); r.checkbox("Finished").onPress();
    if (mode === "expired") r.setPreview({ ...preview(), expiresAt: new Date(Date.now() - 1000).toISOString() }); else r.props.online = false;
    r.render(); const action = r.button("Archive selected (1)").props; assert.equal(action.disabled, true); action.onPress(); await r.wait();
    assert.equal(r.calls.length, 0);
  }
});
test("archive errors consume the preview until a fresh scan and preserve the error message", async () => {
  const r = runtime({ execute: async () => { throw new Error("Unknown archive outcome"); } });
  r.render(); r.checkbox("Finished").onPress(); r.render(); r.button("Archive selected (1)").props.onPress(); await r.wait(); r.render();
  assert.match(r.text(), /Unknown archive outcome/); assert.equal(r.button("Archive selected (1)").props.disabled, true);
  r.button("Scan again").props.onPress(); r.render(); assert.equal(r.checkbox("Finished").accessibilityState.checked, false); assert.equal(r.mutation.isError, false);
});
test("host retention settings validate bounds and save using the current revision", async () => {
  const r = runtime(); r.render("settings"); r.render("settings");
  const input = label => r.button(label).props;
  const delivered = "Keep delivered or closed task conversations for days", unlinked = "Offer unlinked inactive conversations after days";
  assert.equal(input(delivered).value, "7"); assert.equal(input(unlinked).value, "14");
  input(delivered).onChangeText("0"); r.render("settings"); assert.equal(r.button("Save cleanup settings").props.disabled, true);
  input(delivered).onChangeText("366"); r.render("settings"); assert.equal(r.button("Save cleanup settings").props.disabled, true);
  input(delivered).onChangeText("9"); r.render("settings"); await r.button("Save cleanup settings").props.onPress();
  assert.deepEqual(r.saves, [{ values: { deliveredDays: 9, unlinkedDays: 14 }, revision: "revision-1" }]);
  assert.equal(r.cleanup.AgentCleanupSettings({ host: { id: "another-host" }, theme: { colors } }).key, "another-host");
});
test("background settings refresh preserves an unsaved retention choice", () => {
  const r = runtime(); r.render("settings"); r.render("settings");
  const label = "Keep delivered or closed task conversations for days";
  r.button(label).props.onChangeText("10"); r.render("settings");
  r.settings.values = { deliveredDays: 20, unlinkedDays: 21 }; r.settings.revision = "revision-2"; r.render("settings");
  assert.equal(r.button(label).props.value, "10");
});
