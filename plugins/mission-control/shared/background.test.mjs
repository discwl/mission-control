import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { listIncludingBackground, refusesBackground } = require("./background.ts");

// What a 0.12 client says when the host is older than 0.12.
const refusal = new Error("Update the host to use background workspaces.");

test("a list asks for background workspaces and keeps the rest of its filter", async () => {
  const filters = [];
  assert.equal(await listIncludingBackground("host-a", { includeArchived: true }, async filter => { filters.push(filter); return "listed"; }), "listed");
  assert.deepEqual(filters, [{ includeArchived: true, includeBackground: true }]);
});

test("a host that refuses the field is asked again without it, and not asked with it for ten minutes", async () => {
  let clock = 0;
  const filters = [];
  const list = async filter => { filters.push(filter); if ("includeBackground" in filter) throw refusal; return filters.length; };
  assert.equal(await listIncludingBackground("host-b", {}, list, () => clock), 2, "the retry's answer is returned");
  clock += 9 * 60_000;
  await listIncludingBackground("host-b", {}, list, () => clock);
  clock += 2 * 60_000;
  await listIncludingBackground("host-b", {}, list, () => clock);
  assert.deepEqual(filters, [{ includeBackground: true }, {}, {}, { includeBackground: true }, {}]);
});

test("other errors aren't retried, and a refusal only affects its own host", async () => {
  let calls = 0;
  await assert.rejects(listIncludingBackground("host-c", {}, async () => { calls++; throw new Error("offline"); }), /offline/);
  assert.equal(calls, 1);
  await assert.rejects(listIncludingBackground("host-d", {}, async () => { throw refusal; }), /Update the host/);
  const filters = [];
  await listIncludingBackground("host-e", {}, async filter => { filters.push(filter); return null; });
  assert.deepEqual(filters, [{ includeBackground: true }]);
});

test("only the 0.12 client's refusal counts as one", () => {
  assert.equal(refusesBackground(refusal), true);
  assert.equal(refusesBackground("Update the host to use background workspaces."), true);
  assert.equal(refusesBackground(new Error("Transport not connected")), false);
});
