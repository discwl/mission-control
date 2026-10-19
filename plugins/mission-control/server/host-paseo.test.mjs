import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { rememberHostPaseo } = require("./host-paseo.ts");

test("handler calls remember the host's Paseo API, and the rest of the server context is kept", async () => {
  const handlers = new Map();
  // Shaped like the plain object every Paseo version passes to a plugin's server entry.
  const context = { handle: (contract, handler) => handlers.set(contract.name, handler), registerSettings: definition => `settings:${definition.id}`, on: () => "hook", before: () => "before" };
  const { server, current } = rememberHostPaseo(context);
  assert.equal(current(), null, "nothing is known until a handler runs");
  assert.equal(server.registerSettings({ id: "prefs" }), "settings:prefs");
  assert.equal(server.on(), "hook");
  assert.equal(server.before(), "before");
  const api = { agents: {} };
  server.handle({ name: "echo" }, async (input, { paseo }) => ({ input, same: paseo === api }));
  assert.deepEqual(await handlers.get("echo")({ value: 1 }, { paseo: api }), { input: { value: 1 }, same: true });
  assert.equal(current(), api);
});
