import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { branchNameSettings, branchSlug, branchTemplateProblem, branchTypeFor, exampleBranchName, gitBranchNameProblem, templateBranch, ticketTitle } = require("./branch-names.ts");

const ticket = (extra = {}) => ({ system: "jira", key: "ABC-123", url: "https://example.atlassian.net/browse/ABC-123", ...extra });
const task = (extra = {}) => ({ taskId: "task_1234abcd-0000-4000-8000-000000000000", title: "ABC-123 · Add login retry", ticket: ticket(), ...extra });
const names = planned => planned.options.map(option => [option.type, option.name, option.problem]);

test("<ticket>-<slug> uses the ticket key and a slug from the ticket's title", () => {
  const planned = templateBranch(task(), "{ticket}-{slug}");
  assert.equal(planned.kind, "template");
  assert.deepEqual(names(planned), [[null, "ABC-123-add-login-retry", null]]);
});

test("feature/ and bugfix/ templates keep their fixed prefix", () => {
  assert.deepEqual(names(templateBranch(task(), "feature/{ticket}-{slug}")), [[null, "feature/ABC-123-add-login-retry", null]]);
  assert.deepEqual(names(templateBranch(task(), "bugfix/{ticket}-{slug}")), [[null, "bugfix/ABC-123-add-login-retry", null]]);
});

test("{type} comes from the ticket's type when known, otherwise offers feature and bugfix", () => {
  const bug = templateBranch(task({ ticket: ticket({ type: "Bug" }) }), "{type}/{ticket}-{slug}");
  assert.deepEqual(names(bug), [["bugfix", "bugfix/ABC-123-add-login-retry", null]]);
  assert.equal(bug.typeFromTicket, true);
  assert.deepEqual(names(templateBranch(task({ ticket: ticket({ type: "User Story" }) }), "{type}/{ticket}-{slug}")), [["feature", "feature/ABC-123-add-login-retry", null]]);
  const unknown = templateBranch(task(), "{type}/{ticket}-{slug}");
  assert.deepEqual(names(unknown), [["feature", "feature/ABC-123-add-login-retry", null], ["bugfix", "bugfix/ABC-123-add-login-retry", null]]);
  assert.equal(unknown.typeFromTicket, false);
  assert.deepEqual(["Bug", "Production defect", "Hotfix", "Incident", "Story", "Task", "Product Backlog Item", "", undefined].map(branchTypeFor),
    ["bugfix", "bugfix", "bugfix", "bugfix", "feature", "feature", "feature", null, null]);
});

test("{id} is the short Mission Control task ID", () => {
  assert.deepEqual(names(templateBranch(task(), "{ticket}/{id}-{slug}")), [[null, "ABC-123/1234abcd-add-login-retry", null]]);
});

test("no template, or a task without a ticket, keeps the default name", () => {
  assert.deepEqual(templateBranch(task(), undefined), { kind: "default", reason: "no-template" });
  assert.deepEqual(templateBranch(task(), "   "), { kind: "default", reason: "no-template" });
  assert.deepEqual(templateBranch(task({ ticket: undefined }), "{ticket}-{slug}"), { kind: "default", reason: "no-ticket" });
  assert.deepEqual(templateBranch(task({ ticket: undefined }), "feature/{id}-{slug}"), { kind: "default", reason: "no-ticket" });
});

test("the slug comes from the ticket's title, or the task title when the key isn't in front", () => {
  assert.equal(ticketTitle(task()), "Add login retry");
  assert.equal(ticketTitle(task({ title: "abc-123: Add login retry" })), "Add login retry");
  assert.equal(ticketTitle(task({ title: "Add login retry for ABC-123" })), "Add login retry for ABC-123");
  assert.equal(ticketTitle(task({ title: "ABC-123" })), "ABC-123");
  assert.equal(ticketTitle({ title: "No ticket here" }), "No ticket here");
  assert.equal(branchSlug("Café au lait: déjà vu!"), "cafe-au-lait-deja-vu");
  assert.equal(branchSlug("Retry the login when the network drops out for a while"), "retry-the-login-when-the-network-drops");
  assert.equal(branchSlug("x".repeat(60)), "x".repeat(40));
  assert.equal(branchSlug("!!!"), "");
});

test("templates with unknown tokens, stray braces, no unique token, or bad Git characters are refused", () => {
  assert.equal(branchTemplateProblem(""), null);
  assert.equal(branchTemplateProblem("{type}/{ticket}-{slug}"), null);
  assert.match(branchTemplateProblem("{ticket}-{title}"), /\{title\} isn't a token/);
  assert.match(branchTemplateProblem("{ticket-{slug}"), /both braces/);
  assert.match(branchTemplateProblem("feature/{slug}"), /Include \{ticket\} or \{id\}/);
  assert.match(branchTemplateProblem("{ticket} {slug}"), /Git won't accept.*spaces/);
  assert.match(branchTemplateProblem("feature//{ticket}"), /Git won't accept/);
  assert.match(branchTemplateProblem("{ticket}.lock"), /Git won't accept/);
  assert.equal(exampleBranchName("{type}/{ticket}-{slug}"), "feature/ABC-123-add-login-retry");
});

test("a template that renders an invalid name for this ticket reports it per option", () => {
  const planned = templateBranch(task({ title: "ABC 123 · Add login retry", ticket: ticket({ key: "ABC 123" }) }), "{ticket}-{slug}");
  assert.equal(planned.options[0].name, "ABC 123-add-login-retry");
  assert.match(planned.options[0].problem, /spaces/);
  // A stored template that was never checked still can't produce a branch.
  assert.match(templateBranch(task(), "{ticket}-{nope}").options[0].problem, /isn't a token/);
});

test("the Git name check agrees with git check-ref-format --branch", () => {
  // Git accepts a branch named @, but @ also means HEAD, so Mission Control refuses it.
  assert.match(gitBranchNameProblem("@"), /reserved/);
  const names = ["ABC-123-add-login-retry", "feature/ABC-123-x", "bugfix/48213-fix", "task/1234abcd-a", "a.b", "-lead", "HEAD", "a..b", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b",
    "a@{b", "/a", "a/", "a//b", "a.", ".a", "a/.b", "a.lock", "a/b.lock/c", "ok@name", "a\tb"];
  for (const name of names) {
    const git = (() => { try { return execFileSync("git", ["check-ref-format", "--branch", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === name; } catch { return false; } })();
    assert.equal(gitBranchNameProblem(name) === null, git, `${name}: git ${git ? "accepts" : "rejects"} it`);
  }
});

test("the settings default to no template and no overrides", () => {
  assert.deepEqual(branchNameSettings.schema.parse({}), { template: "", projects: {} });
});
