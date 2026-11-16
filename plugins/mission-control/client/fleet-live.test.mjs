import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

/** Loads fleet-live.ts with stand-ins for React, React Query and the plugin SDK, run as a hook outside React. */
function load({ status = "live", subscription = true } = {}) {
  const harness = { onEvent: null, effects: [], timers: [], data: undefined, invalidated: 0, set: [] };
  const cache = {
    getQueryData: () => harness.data,
    setQueryData: (_key, updater) => { harness.data = typeof updater === "function" ? updater(harness.data) : updater; harness.set.push(harness.data); },
    invalidateQueries: () => { harness.invalidated++; },
    getQueryState: () => harness.state,
  };
  const imports = {
    "@getpaseo/plugin/client": subscription ? { useSubscription: (_contract, _input, onEvent) => { harness.onEvent = onEvent; return { status }; } } : {},
    "@tanstack/react-query": { useQueryClient: () => cache },
    react: { useRef: value => ({ current: value }), useEffect: effect => { harness.effects.push(effect()); } },
    "../shared/fleet": { fleetChanges: { name: "orchestrator.fleet.changes" } },
  };
  const code = ts.transpileModule(readFileSync(new URL("./fleet-live.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const setInterval = (callback, ms) => { harness.timers.push({ callback, ms }); return harness.timers.length; };
  new Function("require", "module", "exports", "setInterval", "clearInterval", code)(name => imports[name], module, module.exports, setInterval, () => {});
  return { useFleetLive: module.exports.useFleetLive, harness };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test("live: a push updates the view from a cached read, and a one-minute backstop runs", async () => {
  const { useFleetLive, harness } = load();
  let reads = 0;
  assert.equal(useFleetLive(["fleet", "a"], async () => { reads++; return { observedAt: "2026-11-16T10:00:00Z" }; }), true);
  assert.deepEqual(harness.timers.map(timer => timer.ms), [60_000], "a backstop instead of 20-second forced reads");
  harness.onEvent({ observedAt: "2026-11-16T10:00:00Z" }); await settle();
  assert.equal(reads, 1); assert.equal(harness.data.observedAt, "2026-11-16T10:00:00Z");
  harness.onEvent({ observedAt: "2026-11-16T10:00:00Z" }); await settle();
  assert.equal(reads, 1, "a push about a snapshot the view already has reads nothing");
  harness.timers[0].callback(); await settle();
  assert.equal(reads, 2, "the backstop reads even without a push");
});

test("a cached read never replaces newer data, shares one read per key, and a failed read makes the query re-read", async () => {
  const { useFleetLive, harness } = load();
  harness.data = { observedAt: "2026-11-16T10:05:00Z" };
  let release; let reads = 0;
  useFleetLive(["fleet", "a"], () => { reads++; return new Promise(resolve => { release = () => resolve({ observedAt: "2026-11-16T10:01:00Z" }); }); });
  harness.onEvent({ observedAt: "2026-11-16T10:06:00Z" });
  harness.onEvent({ observedAt: "2026-11-16T10:07:00Z" });
  assert.equal(reads, 1, "two pushes while one read is in flight share it");
  release(); await settle(); await settle();
  assert.equal(harness.data.observedAt, "2026-11-16T10:05:00Z", "older data from a cached read doesn't replace newer data");
  const failing = load();
  failing.harness.data = { observedAt: "2026-11-16T10:00:00Z" };
  failing.useFleetLive(["fleet", "b"], async () => { throw new Error("Plugin RPC timed out"); });
  failing.harness.onEvent({ observedAt: "2026-11-16T10:02:00Z" }); await settle(); await settle();
  assert.equal(failing.harness.invalidated, 1, "the query's own read then reports the failure");
});

test("not live (older app, or the subscription isn't live yet): no backstop, so the view keeps its forced polling", () => {
  for (const options of [{ subscription: false }, { status: "connecting" }, { status: "error" }]) {
    const { useFleetLive, harness } = load(options);
    assert.equal(useFleetLive(["fleet", "a"], async () => ({})), false);
    assert.deepEqual(harness.timers, []);
  }
});

test("a shared read that came back older than the push announced is followed by one more read", async () => {
  const { useFleetLive, harness } = load();
  harness.data = { observedAt: "2026-11-16T10:00:00Z" };
  const answers = ["2026-11-16T10:01:00Z", "2026-11-16T10:02:00Z"]; let release; let reads = 0;
  useFleetLive(["fleet", "a"], () => { const answer = answers[reads++]; return reads === 1 ? new Promise(resolve => { release = () => resolve({ observedAt: answer }); }) : Promise.resolve({ observedAt: answer }); });
  harness.onEvent({ observedAt: "2026-11-16T10:01:00Z" });
  harness.onEvent({ observedAt: "2026-11-16T10:02:00Z" });
  assert.equal(reads, 1);
  release(); await settle(); await settle(); await settle();
  assert.equal(reads, 2, "one more read for the newer snapshot");
  assert.equal(harness.data.observedAt, "2026-11-16T10:02:00Z");
});

test("failed cached reads make the query re-read at most once a minute, and not while it already shows an error", async () => {
  const { useFleetLive, harness } = load();
  harness.data = { observedAt: "2026-11-16T10:00:00Z" };
  useFleetLive(["fleet", "a"], async () => { throw new Error("cannot parse"); });
  for (let push = 1; push <= 5; push++) { harness.onEvent({ observedAt: `2026-11-16T10:0${push}:00Z` }); await settle(); await settle(); }
  assert.equal(harness.invalidated, 1, "one forced re-read, not one per push");
  const shown = load(); shown.harness.data = { observedAt: "2026-11-16T10:00:00Z" }; shown.harness.state = { status: "error" };
  shown.useFleetLive(["fleet", "b"], async () => { throw new Error("cannot parse"); });
  shown.harness.onEvent({ observedAt: "2026-11-16T10:01:00Z" }); await settle(); await settle();
  assert.equal(shown.harness.invalidated, 0, "the view already shows the failure");
});
