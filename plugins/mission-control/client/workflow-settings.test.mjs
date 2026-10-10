import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const rules = require("../shared/workflow-instructions.mjs");
const flush = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (revision = "rev-1") => ({ serverId: "srv_a", hostId: "a", projectId: "prj_a", host: { intake: "Host intake", planning: "Host planning" }, project: { intake: "", planning: "", intakeMode: "inherit", planningMode: "inherit" }, effective: { intake: "Host intake", planning: "Host planning" }, revision, paths: { host: "vault/Workflow/host.md", project: "vault/Workflow/Projects/prj_a.md" } });
function runtime(initial, handler) {
  let data = initial, queryError = null, index = 0;
  const state = [], nodes = [], calls = [], queries = [], editing = [];
  const mutation = { isPending: false, error: null, reset() { mutation.error = null; }, mutate: null };
  const jsx = (type, props) => ({ type, props });
  const compiled = ts.transpileModule(readFileSync(new URL("./workflow-settings.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(id => {
    if (id === "react") return { useState(initial) { const slot = index++; if (!(slot in state)) state[slot] = typeof initial === "function" ? initial() : initial; return [state[slot], value => { state[slot] = typeof value === "function" ? value(state[slot]) : value; }]; }, useEffect: effect => effect() };
    if (id === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (id === "react-native") return { Text: "Text", TextInput: "TextInput", View: "View" };
    if (id === "./compact-link") return { CompactLink: "CompactLink" };
    if (id === "@getpaseo/plugin/client/ui") return { SettingsRow: "SettingsRow", SettingsSection: "SettingsSection" };
    if (id === "@getpaseo/plugin/client") return { useRpc: name => async input => { calls.push({ name, input }); return name === "read" ? data : handler(input); }, usePaseo: () => ({}) };
    if (id === "../shared/workflow-settings") return { getWorkflowInstructions: "read", saveWorkflowInstructions: "save" };
    if (id === "../shared/workflow-instructions.mjs") return rules;
    if (id === "@tanstack/react-query") return {
      useQuery(options) { queries.push(options); return { data, error: queryError, isPending: !data && !queryError, refetch: async () => { calls.push({ name: "reload" }); return { data }; } }; },
      useQueryClient: () => ({ setQueryData: (_key, value) => { data = value; } }),
      useMutation(options) { mutation.mutate = () => { mutation.isPending = true; void options.mutationFn().then(value => options.onSuccess(value), error => { mutation.error = error; }).finally(() => { mutation.isPending = false; }); }; return mutation; },
    };
    throw new Error(`Unexpected import ${id}`);
  }, module, module.exports);
  const props = { host: { id: "srv_a" }, theme: { colors: { foreground: "fg", foregroundMuted: "muted", surface1: "surface", border: "border", statusDanger: "danger", statusSuccess: "success" } }, projectId: initial ? initial.projectId : "prj_a", onEditingChange: value => editing.push(value) };
  function render() {
    index = 0; nodes.length = 0;
    const visit = node => { if (!node || typeof node !== "object") return; if (Array.isArray(node)) return node.forEach(visit); nodes.push(node); visit(node.props?.children); };
    visit(module.exports.WorkflowEditor(props));
    return nodes;
  }
  const button = label => { const node = nodes.find(node => node.type === "CompactLink" && (node.props.label === label || node.props.accessibilityLabel === label)); assert.ok(node, `missing ${label}`); return node.props; };
  const input = stage => { const node = nodes.find(node => node.type === "TextInput" && node.props.accessibilityLabel === `${stage} instructions`); assert.ok(node); return node.props; };
  return { render, nodes, calls, queries, editing, props, mutation, button, input, setData: value => { data = value; }, setError: error => { queryError = error; }, press: label => { const target = button(label); assert.ok(!target.disabled); target.onPress(); }, text: () => JSON.stringify(nodes.map(node => node.props?.children)) };
}

test("project modes update the effective preview without writing and keep native multiline inputs", () => {
  const r = runtime(snapshot()); r.render();
  assert.equal(r.input("Intake").editable, false);
  r.press("intake: Add to host"); r.render();
  r.input("Intake").onChangeText("Ask about business rules."); r.render();
  assert.match(r.text(), /Host intake\\n\\nAsk about business rules\./);
  assert.equal(r.input("Intake").multiline, true);
  assert.equal(r.input("Intake").style.color, "fg");
  assert.equal(r.calls.length, 0);
  r.press("intake: Replace host"); r.render();
  assert.ok(r.text().includes("Ask about business rules."));
  assert.ok(r.editing.at(-1));
});

test("saving uses the selected host/project and the original revision, and reports success", async () => {
  const r = runtime(snapshot(), async input => ({ ...snapshot("rev-2"), project: input.values }));
  r.render();
  await r.queries[0].queryFn();
  assert.deepEqual(r.calls[0], { name: "read", input: { serverId: "srv_a", projectId: "prj_a" } });
  r.press("planning: Add to host"); r.render();
  r.input("Planning").onChangeText("Read the database schema."); r.render(); r.press("Save instructions");
  await flush(); r.render();
  const call = r.calls.find(call => call.name === "save");
  assert.equal(call.input.serverId, "srv_a"); assert.equal(call.input.projectId, "prj_a"); assert.equal(call.input.expectedRevision, "rev-1");
  assert.equal(call.input.values.planning, "Read the database schema.");
  assert.match(r.text(), /Workflow instructions saved\./);
  assert.ok(r.button("Save instructions").disabled);
  assert.equal(r.editing.at(-1), false);
});

test("background refresh preserves drafts and blocks overwriting a concurrent save", () => {
  const r = runtime(snapshot()); r.render(); r.press("intake: Add to host"); r.render();
  r.input("Intake").onChangeText("My draft");
  r.setData({ ...snapshot("rev-2"), host: { intake: "Someone else's host edit", planning: "" } }); r.render();
  assert.equal(r.input("Intake").value, "My draft");
  assert.ok(r.button("Save instructions").disabled);
  assert.match(r.text(), /changed elsewhere/);
  r.press("Discard changes"); r.render();
  assert.equal(r.input("Intake").value, "");
  assert.match(r.text(), /Someone else's host edit/);
  assert.equal(r.editing.at(-1), false);
});

test("host defaults save only their scope and save failures preserve the user's draft", async () => {
  const current = { ...snapshot(), projectId: null, paths: { host: "vault/Workflow/host.md", project: null } };
  const r = runtime(current, async () => { throw new Error("Vault unavailable"); }); r.render();
  r.input("Intake").onChangeText("Clarify missing acceptance criteria."); r.render(); r.press("Save instructions");
  await flush(); r.render();
  const call = r.calls.find(call => call.name === "save");
  assert.equal(call.input.projectId, null);
  assert.deepEqual(call.input.values, { intake: "Clarify missing acceptance criteria.", planning: "Host planning" });
  assert.match(r.text(), /Vault unavailable/);
  assert.equal(r.input("Intake").value, "Clarify missing acceptance criteria.");
  assert.ok(r.editing.at(-1));
});

test("pending saves disable fields and scope changes, and read failures stay visible", async () => {
  let finish;
  const r = runtime(snapshot(), input => new Promise(resolve => { finish = () => resolve({ ...snapshot("rev-2"), project: input.values }); }));
  r.render(); r.press("intake: Add to host"); r.render(); r.press("Save instructions"); await flush(); r.render();
  assert.equal(r.input("Intake").editable, false);
  assert.equal(r.button("Discard changes").disabled, true);
  assert.equal(r.button("planning: Add to host").disabled, true);
  finish(); await flush();
  const failed = runtime(undefined); failed.setError(new Error("Wrong host")); failed.render();
  assert.match(failed.text(), /Wrong host/);
});
