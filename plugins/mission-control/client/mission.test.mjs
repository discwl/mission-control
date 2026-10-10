import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { permissionChoices, permissionDetail } = require("./permission-detail.ts");
const { missionButtonId, missionLabel } = require("./mission-buttons.ts");

test("Mission button IDs use only letters, digits and hyphens", () => {
  assert.equal(missionButtonId("wks_40978f9035a2bbcd"), "mission-wks-40978f9035a2bbcd");
  assert.match(missionButtonId("Weird ID/1"), /^[a-z0-9-]+$/);
});

test("permission details show the command, file, search or URL the agent wants", () => {
  assert.equal(permissionDetail({ id: "p1", name: "Bash", kind: "tool", detail: { type: "shell", command: "npm test", cwd: "C:\\repo" } }), "npm test\n(in C:\\repo)");
  assert.equal(permissionDetail({ id: "p2", name: "Edit", kind: "tool", detail: { type: "edit", filePath: "src/a.ts" } }), "edit src/a.ts");
  assert.equal(permissionDetail({ id: "p3", name: "Fetch", kind: "tool", detail: { type: "fetch", url: "https://example.com" } }), "fetch https://example.com");
  assert.equal(permissionDetail({ id: "p4", name: "Tool", kind: "tool", input: { path: "x" } }), '{"path":"x"}');
  assert.equal(permissionDetail({ id: "p5", name: "Plan", kind: "plan" }), null);
});

test("permission choices use the request's own actions, otherwise Allow and Deny", () => {
  assert.deepEqual(permissionChoices({ id: "p", name: "Bash", kind: "tool" }).map(choice => [choice.label, choice.behavior]), [["Allow", "allow"], ["Deny", "deny"]]);
  const custom = permissionChoices({ id: "p", name: "Plan", kind: "plan", actions: [
    { id: "go", label: "Implement", behavior: "allow", variant: "primary" },
    { id: "stop", label: "Keep planning", behavior: "deny" },
  ] });
  assert.deepEqual(custom.map(choice => [choice.id, choice.behavior, choice.tone]), [["go", "allow", "primary"], ["stop", "deny", "danger"]]);
});

test("the Mission header button only shows a label when something needs you", () => {
  assert.equal(missionLabel(0), null);
  assert.equal(missionLabel(1), "1 needs you");
  assert.equal(missionLabel(3), "3 need you");
});
