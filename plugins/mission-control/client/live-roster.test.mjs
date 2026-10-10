import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { createLiveRosters, LIVE_BACKSTOP_MS, LIVE_DEBOUNCE_MS } = require("./live-roster.ts");

function harness() {
  const timers = [];
  const fake = {
    set(run, ms) { const timer = { run, ms, cleared: false }; timers.push(timer); return timer; },
    clear(timer) { timer.cleared = true; },
  };
  const listeners = new Map();
  const stopped = [];
  const refreshed = [];
  const retain = createLiveRosters((serverId, changed) => {
    listeners.set(serverId, [...listeners.get(serverId) ?? [], changed]);
    return () => stopped.push(serverId);
  }, serverId => refreshed.push(serverId), fake);
  const fire = () => { for (const timer of timers.splice(0)) if (!timer.cleared) timer.run(); };
  return { retain, listeners, stopped, refreshed, timers, fire };
}

test("updates are debounced by about 500 ms and the backstop is 30 seconds", () => {
  assert.equal(LIVE_DEBOUNCE_MS, 500);
  assert.equal(LIVE_BACKSTOP_MS, 30_000);
  const { retain, listeners, refreshed, timers, fire } = harness();
  retain("srv_a");
  const changed = listeners.get("srv_a")[0];
  changed(); changed(); changed();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 500);
  assert.deepEqual(refreshed, []);
  fire();
  assert.deepEqual(refreshed, ["srv_a"]);
  // A later update starts a new window.
  changed();
  fire();
  assert.deepEqual(refreshed, ["srv_a", "srv_a"]);
});

test("views share one subscription per host, which stops when the last one lets go", () => {
  const { retain, listeners, stopped, timers, refreshed, fire } = harness();
  const first = retain("srv_a");
  const second = retain("srv_a");
  const other = retain("srv_b");
  assert.equal(listeners.get("srv_a").length, 1);
  assert.equal(listeners.get("srv_b").length, 1);
  first();
  first();
  assert.deepEqual(stopped, []);
  listeners.get("srv_a")[0]();
  second();
  assert.deepEqual(stopped, ["srv_a"]);
  // The pending refresh is dropped with it, and late updates from the old subscription are ignored.
  assert.equal(timers[0].cleared, true);
  listeners.get("srv_a")[0]();
  fire();
  assert.deepEqual(refreshed, []);
  // Coming back starts a fresh subscription.
  retain("srv_a");
  assert.equal(listeners.get("srv_a").length, 2);
  other();
  assert.deepEqual(stopped, ["srv_a", "srv_b"]);
});
