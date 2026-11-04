import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url), ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { parseChatConsent } = require("./chat-actions.ts");
test("action authorization requires the exact standalone human phrase and offer ID", () => {
  const id = "123456abcd";
  for (const text of ["yes", "yes approve", `yes approve ${id}`, `approve: ${id}`, `open draft pr ${id}`, "authorize actions", "authorize actions another", `Please authorize actions ${id}`, `authorize actions ${id}\nAdditional context`, `request changes: ${id}`]) assert.equal(parseChatConsent(text, "actions", id), null, text);
  assert.deepEqual(parseChatConsent(`authorize actions ${id}`, "actions", id), { outcome: "authorize", note: "" });
  assert.equal(parseChatConsent(`authorize actions ${id}`, "draft-pr", id), null);
  assert.equal(parseChatConsent(`authorize actions ${id}`, "plan", id), null);
});
