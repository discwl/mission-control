import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { parseOrchestratorHostFile } = require("./orchestrator.ts");

const parse = value => parseOrchestratorHostFile(typeof value === "string" ? value : JSON.stringify(value), "srv_local");

test("a host file names the remote host it orchestrates", () => {
  assert.deepEqual(parse({ schemaVersion: 1, label: " Acme ", serverId: " srv_remote " }), { binding: { label: "Acme", serverId: "srv_remote" } });
});

test("a vault's own host.json isn't an orchestrator binding", () => {
  assert.equal(parse({ schemaVersion: 1, hostId: "personal", serverId: "srv_local" }), null);
});

test("unusable host files explain what to fix", () => {
  assert.match(parse("{ not json").problem, /isn't valid JSON/);
  assert.match(parse(["Acme"]).problem, /JSON object/);
  assert.match(parse({ label: "Acme", serverId: "srv_remote" }).problem, /schemaVersion/);
  assert.match(parse({ schemaVersion: 1, label: "  ", serverId: "srv_remote" }).problem, /"label"/);
  assert.match(parse({ schemaVersion: 1, label: "Acme" }).problem, /"serverId"/);
  assert.match(parse({ schemaVersion: 1, label: "Personal", serverId: "srv_local" }).problem, /this host itself/);
});
