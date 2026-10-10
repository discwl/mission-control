import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { followsUpdate, lastUpdateNotice, updateLogHint, updateTimeoutMessage } = require("./plugin-update-view.ts");

const idle = { updating: false, checking: false, lastUpdateError: null, timedOutAt: null, checkedAt: 100 };

test("a timed-out update is reported until a newer check finishes", () => {
  assert.equal(lastUpdateNotice({ ...idle, timedOutAt: 200, checkedAt: 100 }), updateTimeoutMessage);
  // Check for updates is running: the old result is stale, so nothing about the old update shows.
  assert.equal(lastUpdateNotice({ ...idle, timedOutAt: 200, checkedAt: 100, checking: true }), null);
  // The newer check shows the real state.
  assert.equal(lastUpdateNotice({ ...idle, timedOutAt: 200, checkedAt: 300 }), null);
});

test("the old check that timed out can't restart the wait, but a newer one can", () => {
  assert.equal(followsUpdate(true, 100, 200), false);
  assert.equal(followsUpdate(true, 300, 200), true);
  assert.equal(followsUpdate(true, 100, null), true);
  assert.equal(followsUpdate(false, 300, null), false);
});

test("a failure the server reported shows, except while updating or checking", () => {
  assert.equal(lastUpdateNotice({ ...idle, lastUpdateError: "Build failed" }), "Build failed");
  assert.equal(lastUpdateNotice({ ...idle, lastUpdateError: "Build failed", updating: true }), null);
  assert.equal(lastUpdateNotice({ ...idle, lastUpdateError: "Build failed", checking: true }), null);
  assert.equal(lastUpdateNotice(idle), null);
});

test("the hint names the update log file instead of paseo plugin logs", () => {
  assert.match(updateLogHint, /%TEMP%\\mission-control-plugin-update\.log/);
  assert.doesNotMatch(updateLogHint, /paseo plugin logs/);
});
