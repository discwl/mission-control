import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { orchestratorDialogKey, isOrchestratorDialogOpen, setOrchestratorDialogOpen, subscribeOrchestratorDialogs } = require("./orchestrator-dialog-request.ts");
const { requestHostDestination, takeHostDestination } = require("./host-review-request.ts");

test("dialogs remain isolated by chat, workspace, host, and kind; closing does not reopen another dialog", () => {
  const key = orchestratorDialogKey("w", "chat", "host", "review");
  const others = [orchestratorDialogKey("w", "other", "host", "review"), orchestratorDialogKey("w2", "chat", "host", "review"), orchestratorDialogKey("w", "chat", "other", "review"), orchestratorDialogKey("w", "chat", "host", "attention")];
  let events = 0;
  const stop = subscribeOrchestratorDialogs(() => events++);
  setOrchestratorDialogOpen(key, true);
  assert.equal(isOrchestratorDialogOpen(key), true);
  assert.ok(others.every(other => !isOrchestratorDialogOpen(other)));
  setOrchestratorDialogOpen(key, true);
  assert.equal(events, 1);
  setOrchestratorDialogOpen(key, false);
  assert.equal(events, 2);
  assert.ok(others.every(other => !isOrchestratorDialogOpen(other)));
  stop();
});
test("a changed host binding cannot consume a destination intended for another host", () => {
  requestHostDestination("w", { serverId: "old", kind: "agent", id: "worker" });
  assert.equal(takeHostDestination("w", "new"), null);
  assert.equal(takeHostDestination("w", "old"), null);
});
