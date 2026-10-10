import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { answerProblem } = require("./decision-note.ts");

const answer = overrides => answerProblem({ kind: "review", outcome: "approved", openFindings: 0, selected: 0, note: "", ...overrides });

test("an answer that needs nothing more goes straight through", () => {
  assert.equal(answer({}), null);
  assert.equal(answer({ kind: "plan" }), null);
  assert.equal(answer({ outcome: "changes_requested", openFindings: 2, selected: 2 }), null);
  assert.equal(answer({ outcome: "blocked", note: "Wrong branch." }), null);
});

test("a brief card asks for what the server would require, in the server's words", () => {
  assert.equal(answer({ outcome: "blocked" }), "Add a note explaining the block.");
  assert.equal(answer({ outcome: "blocked", note: "   " }), "Add a note explaining the block.");
  assert.equal(answer({ kind: "plan", outcome: "changes_requested" }), "Describe the plan changes you want.");
  assert.equal(answer({ outcome: "changes_requested", openFindings: 2, selected: 0 }), "Select at least one finding to fix.");
  assert.equal(answer({ openFindings: 1 }), "Add a note explaining why 1 finding is dismissed.");
  assert.equal(answer({ outcome: "changes_requested", openFindings: 3, selected: 1 }), "Add a note explaining why 2 findings are dismissed.");
  assert.equal(answer({ openFindings: 3, note: "Not worth it." }), null);
});
