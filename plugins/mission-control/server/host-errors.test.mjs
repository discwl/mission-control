import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { transientHostError } = require("./host-errors.ts");
const { isRequestTimeout } = require("../shared/request-timeout.ts");

const slow = "it answered too slowly";
const coded = (message, code) => Object.assign(new Error(message), { code });

test("Paseo 0.16.1's request timeout wording means the host answered too slowly", () => {
  assert.equal(transientHostError(new Error("No response to fetch_agents_request after 60000ms")), slow);
  assert.equal(transientHostError(new Error("Request failed: No response to plugin.rpc.invoke.request after 30000ms")), slow);
  assert.equal(transientHostError("No response to daemon.get_status.request after 1500ms"), slow);
});

test("the older timeout wordings still count", () => {
  assert.equal(transientHostError(new Error("Timeout waiting for message (60000ms)")), slow);
  assert.equal(transientHostError(new Error("Request failed: Plugin RPC timed out: mission-control.invoke")), slow);
  assert.equal(transientHostError(new Error("Mission Control did not respond within 25 seconds")), slow);
});

test("an error coded DAEMON_REQUEST_TIMEOUT counts whatever its message says", () => {
  assert.equal(transientHostError(coded("something new", "DAEMON_REQUEST_TIMEOUT")), slow);
  assert.equal(isRequestTimeout({ code: "DAEMON_REQUEST_TIMEOUT", message: "" }), true);
  assert.equal(transientHostError(coded("something new", "DAEMON_CONNECTION_FAILED")), null);
});

test("a bare timeout raised by a handler is not a host hiccup", () => {
  for (const message of ["timed out", "Request timed out", "workspace activation timed out", "No response from the reviewer"]) {
    assert.equal(transientHostError(new Error(message)), null, message);
    assert.equal(isRequestTimeout(new Error(message)), false, message);
  }
});

test("the other transient kinds keep their reasons", () => {
  assert.equal(transientHostError(new Error("Plugin is not available: mission-control")), "its Mission Control was restarting");
  assert.equal(transientHostError(new Error("Transport closed")), "the connection dropped");
});
