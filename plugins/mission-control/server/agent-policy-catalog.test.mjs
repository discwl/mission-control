import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url), ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { verifyProfileAvailability } = require("./agent-policy.ts");
const profile = { id: "plan", name: "Plan", provider: "opencode", model: "gateway/model", thinkingOptionId: "high", modeId: "safe" };
function fixture() {
  const calls = [];
  const paseo = { providers: {
    listAvailable: async () => ({ providers: [{ provider: "opencode", available: true }] }),
    listModels: async (provider, options) => { calls.push({ kind: "models", provider, options }); return { models: [{ id: profile.model, thinkingOptions: [{ id: "high" }] }] }; },
    listModes: async (provider, options) => { calls.push({ kind: "modes", provider, options }); return { modes: [{ id: "safe" }] }; },
  } };
  return { paseo, calls, policy: { profiles: [profile] } };
}
test("profile model and permission discovery use the owning workspace", async () => {
  const f = fixture();
  await verifyProfileAvailability(f.paseo, f.policy, "C:/work/first");
  await verifyProfileAvailability(f.paseo, f.policy, "C:/work/second");
  assert.deepEqual(f.calls, [
    { kind: "models", provider: "opencode", options: { cwd: "C:/work/first" } },
    { kind: "modes", provider: "opencode", options: { cwd: "C:/work/first" } },
    { kind: "models", provider: "opencode", options: { cwd: "C:/work/second" } },
    { kind: "modes", provider: "opencode", options: { cwd: "C:/work/second" } },
  ]);
});
test("host-level profile validation retains default discovery when no workspace is supplied", async () => {
  const f = fixture();
  await verifyProfileAvailability(f.paseo, f.policy);
  assert.deepEqual(f.calls.map(call => call.options), [undefined, undefined]);
});
test("a workspace catalog failure is reported and never retried against the default location", async () => {
  const f = fixture();
  f.paseo.providers.listModels = async (provider, options) => { f.calls.push({ provider, options }); return { error: "workspace activation timed out", models: [{ id: profile.model }] }; };
  await assert.rejects(verifyProfileAvailability(f.paseo, f.policy, "C:/work/first"), /Plan: workspace activation timed out/);
  assert.deepEqual(f.calls, [{ provider: "opencode", options: { cwd: "C:/work/first" } }]);
});
test("workspace catalogs still enforce model, reasoning and mode availability", async () => {
  for (const field of ["model", "thinkingOptionId", "modeId"]) {
    const f = fixture(); f.policy.profiles = [{ ...profile, [field]: "missing" }];
    await assert.rejects(verifyProfileAvailability(f.paseo, f.policy, "C:/work/first"), /unavailable/);
    assert.ok(f.calls.every(call => call.options.cwd === "C:/work/first"));
  }
});
