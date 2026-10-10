import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { parseDiff } = require("./review-diff.ts");
const { classifyHunk } = require("./review-rules.ts");
const { collectSnapshot, untrackedDiff } = require("./review.ts");

test("hunk bodies follow header counts, so markers and trailing blanks never shift line numbers", () => {
  const raw = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@ function run() {",
    " keep",
    "-old",
    "\\ No newline at end of file",
    "+new",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  const [file] = parseDiff(raw);
  assert.equal(file.path, "src/a.ts");
  const [hunk] = file.hunks;
  assert.equal(hunk.context, "function run() {");
  assert.deepEqual(hunk.lines.map(line => [line.kind, line.old, line.new]), [
    ["context", 1, 1], ["del", 2, null], ["meta", null, null], ["add", null, 2], ["meta", null, null],
  ]);
  assert.equal(file.additions, 1);
  assert.equal(file.deletions, 1);
});

test("paths with spaces, renames, binaries and quoted names are parsed", () => {
  const raw = [
    "diff --git a/my notes.txt b/my notes.txt", "new file mode 100644", "--- /dev/null", "+++ b/my notes.txt", "@@ -0,0 +1 @@", "+hi",
    "diff --git a/old.ts b/new.ts", "similarity index 90%", "rename from old.ts", "rename to new.ts",
    "diff --git a/logo.png b/logo.png", "Binary files a/logo.png and b/logo.png differ",
    "diff --git \"a/caf\\303\\251.md\" \"b/caf\\303\\251.md\"", "--- \"a/caf\\303\\251.md\"", "+++ \"b/caf\\303\\251.md\"", "@@ -1 +1 @@", "-a", "+b",
  ].join("\n");
  const files = parseDiff(raw);
  assert.deepEqual(files.map(file => [file.path, file.change, file.oldPath]), [
    ["my notes.txt", "added", null], ["new.ts", "renamed", "old.ts"], ["logo.png", "binary", null], ["café.md", "modified", null],
  ]);
});

test("content IDs ignore line positions but change with the block's content", () => {
  const block = (start, text) => parseDiff(`diff --git a/x.ts b/x.ts\n@@ -${start},1 +${start},1 @@\n-a\n+${text}\n`)[0].hunks[0].contentId;
  assert.equal(block(3, "b"), block(40, "b"));
  assert.notEqual(block(3, "b"), block(3, "c"));
});

test("rules use word boundaries and path context", () => {
  assert.equal(classifyHunk("src/map.ts", ["+const m = new HashMap();"]).severity, "low");
  assert.deepEqual(classifyHunk("src/api.ts", ["+export function load() {}"]), { severity: "medium", reasons: ["New export"] });
  assert.deepEqual(classifyHunk("src/api.ts", ["-export function load() {}", "+export function load(id) {}"]), { severity: "high", reasons: ["Public API change"] });
  assert.equal(classifyHunk("src/api.test.ts", ["+export function helper() {}"]).severity, "low");
  assert.equal(classifyHunk("docs/guide.md", ["+Call eval to run it."]).severity, "info");
  assert.equal(classifyHunk("src/a.ts", ["+// just a comment"]).severity, "info");
  assert.equal(classifyHunk(".github/workflows/ci.yml", ["+  run: npm test"]).severity, "medium");
  assert.ok(classifyHunk("src/io.ts", ["-} catch (error) {"]).reasons.includes("Error handling"));
});

test("a repository with no commits is compared with the empty tree, including untracked files", async t => {
  const repo = await mkdtemp(join(tmpdir(), "mission-review-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", repo]);
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src", "a.ts"), "export const a = 1;\n");
  execFileSync("git", ["-C", repo, "add", "src/a.ts"]);
  await writeFile(join(repo, "notes.md"), "# Notes\n");
  const first = await collectSnapshot(repo);
  assert.equal(first.base, "empty");
  assert.equal(first.head, null);
  assert.deepEqual(first.files.map(file => [file.path, file.change, file.severity]), [["src/a.ts", "added", "medium"], ["notes.md", "added", "info"]]);
  await writeFile(join(repo, "notes.md"), "# Notes\nMore\n");
  const second = await collectSnapshot(repo);
  assert.notEqual(second.fingerprint, first.fingerprint);
});

test("untracked files parse exactly like Git's own diff, so content IDs and marks carry over", async t => {
  const repo = await mkdtemp(join(tmpdir(), "mission-untracked-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", repo]);
  await mkdir(join(repo, "nested"));
  const files = {
    "plain.txt": "one\ntwo\n", "no-newline.txt": "one\ntwo", "single.txt": "only\n", "empty.txt": "",
    "crlf.txt": "a\r\nb\r\n", "blank-lines.md": "\n\n# Title\n\n", "space name.ts": "export const x = 1;\n",
    "café.md": "# Café\n", "data.bin": Buffer.from([1, 0, 2, 3]), "nested/deep.ts": "export {};\n",
  };
  for (const [name, content] of Object.entries(files)) await writeFile(join(repo, name), content);
  const flags = ["--no-color", "--no-ext-diff", "--no-textconv", "-M", "--src-prefix=a/", "--dst-prefix=b/"];
  for (const name of Object.keys(files)) {
    const git = spawnSync("git", ["-c", "core.quotePath=true", "-C", repo, "diff", ...flags, "--no-index", "--", "/dev/null", name], { encoding: "utf8" });
    assert.equal(git.status, 1, `git lists ${name} as new`);
    assert.deepEqual(parseDiff(await untrackedDiff(repo, name)), parseDiff(git.stdout), name);
  }
  assert.equal(await untrackedDiff(repo, "vanished.txt"), "", "a file removed after listing is skipped");
});

test("a large untracked file never fails the review: binary shows as binary, oversized text without lines", async t => {
  const repo = await mkdtemp(join(tmpdir(), "mission-untracked-large-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", repo]);
  const size = 9 * 1024 * 1024;
  const binary = Buffer.alloc(size, 7);
  binary[10] = 0;
  await writeFile(join(repo, "trace.zip"), binary);
  await writeFile(join(repo, "huge.log"), "x\n".repeat(size / 2));
  const git = spawnSync("git", ["-c", "core.quotePath=true", "-C", repo, "diff", "--no-color", "--no-index", "--src-prefix=a/", "--dst-prefix=b/", "--", "/dev/null", "trace.zip"], { encoding: "utf8" });
  assert.deepEqual(parseDiff(await untrackedDiff(repo, "trace.zip")), parseDiff(git.stdout));
  const snapshot = await collectSnapshot(repo);
  assert.deepEqual(snapshot.files.map(file => [file.path, file.change, file.hunks.length]).sort(), [["huge.log", "added", 0], ["trace.zip", "binary", 0]]);
});

const { createReviewMarkStore, countToReview } = require("./review-marks.ts");
const { pillLabel } = require("../client/review-pills.ts");

test("reviewed marks persist per workspace, serialize concurrent writes, and count unfinished files", async t => {
  const vault = await mkdtemp(join(tmpdir(), "mission-marks-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  const store = createReviewMarkStore(vault);
  const [a, b, c] = ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"];
  await Promise.all([store.set("wks_1", [a], true), store.set("wks_1", [b], true), store.set("wks_2", [c], true)]);
  assert.deepEqual(Object.keys((await store.read("wks_1")).marks).sort(), [a, b]);
  assert.deepEqual(Object.keys((await createReviewMarkStore(vault).read("wks_2")).marks), [c], "marks survive a new store instance");
  await store.set("wks_1", [a], false);
  await store.setFrom("wks_1", "0123456789abcdef0123456789abcdef01234567");
  const { marks, from } = await store.read("wks_1");
  assert.equal(from, "0123456789abcdef0123456789abcdef01234567");
  const files = [{ reviewIds: [a, b] }, { reviewIds: [b] }];
  assert.equal(countToReview(files, marks), 1);
  await assert.rejects(store.read("../escape"), /Invalid workspace/);
});

test("the chat bubble hides when nothing changed and shows progress otherwise", () => {
  assert.equal(pillLabel(null), null);
  assert.equal(pillLabel({ files: 0, toReview: 0 }), "Review");
  assert.equal(pillLabel({ files: 4, toReview: 3 }), "Review · 3 to review");
  assert.equal(pillLabel({ files: 4, toReview: 0 }), "Review · ✓ 4 reviewed");
});

const { createReviewCommentStore, commentMessage } = require("./review-comments.ts");

function fakePaseo(agent, { failSend = false } = {}) {
  const sent = [];
  return {
    sent,
    paseo: { agents: { ref: id => ({
      refresh: async () => ({ agent: { id, workspaceId: "wks_1", status: "idle", activeTurn: null, pendingPermissions: [], archivedAt: null, ...agent } }),
      send: async text => { if (failSend) throw new Error("socket closed"); sent.push(text); },
    }) } },
  };
}

test("comments can be edited and deleted only before sending, and sending claims them once", async t => {
  const vault = await mkdtemp(join(tmpdir(), "mission-comments-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  const store = createReviewCommentStore(vault);
  const anchor = { side: "new", line: 4, contentId: "aaaaaaaaaaaaaaaa", text: "const x = 1;" };
  let comments = await store.save("wks_1", { path: "src/a.ts", anchor, body: "Use the helper." });
  comments = await store.save("wks_1", { path: "src/b.ts", anchor: null, body: "Split this file." });
  const [first, second] = comments;
  comments = await store.save("wks_1", { commentId: first.commentId, path: "src/a.ts", anchor, body: "Use the shared helper." });
  assert.equal(comments[0].body, "Use the shared helper.");

  const busy = fakePaseo({ status: "running" });
  await assert.rejects(store.send("wks_1", { agentId: "agent-1", commentIds: [first.commentId], workspaceName: "W", scopeLabel: "S" }, busy.paseo), /busy/);
  const other = fakePaseo({ workspaceId: "wks_2" });
  await assert.rejects(store.send("wks_1", { agentId: "agent-1", commentIds: [first.commentId], workspaceName: "W", scopeLabel: "S" }, other.paseo), /another workspace/);

  const ok = fakePaseo({});
  const result = await store.send("wks_1", { agentId: "agent-1", commentIds: [first.commentId, second.commentId], workspaceName: "Mission Control", scopeLabel: "uncommitted changes" }, ok.paseo);
  assert.equal(result.error, null);
  assert.equal(ok.sent.length, 1);
  assert.match(ok.sent[0], /Mission Control/);
  assert.ok(ok.sent[0].includes(`[${first.commentId}] src/a.ts line 4 (current code)\n> const x = 1;\nComment: Use the shared helper.`));
  assert.match(ok.sent[0], /src\/b.ts \(whole file\)/);
  assert.deepEqual(result.comments.map(comment => comment.status), ["sent", "sent"]);
  await assert.rejects(store.send("wks_1", { agentId: "agent-1", commentIds: [first.commentId], workspaceName: "W", scopeLabel: "S" }, ok.paseo), /Only unsent/);
  await assert.rejects(store.update("wks_1", first.commentId, "delete"), /kept/);
  await assert.rejects(store.save("wks_1", { commentId: first.commentId, path: "src/a.ts", anchor, body: "edit" }), /unsent/);
  comments = await store.update("wks_1", first.commentId, "resolve");
  assert.equal(comments[0].status, "resolved");
  comments = await store.update("wks_1", first.commentId, "reopen");
  assert.equal(comments[0].status, "open");
});

test("a failed send stays unconfirmed until the user says whether it arrived", async t => {
  const vault = await mkdtemp(join(tmpdir(), "mission-comments-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  const store = createReviewCommentStore(vault);
  const [comment] = await store.save("wks_1", { path: "src/a.ts", anchor: null, body: "Check this." });
  const failing = fakePaseo({}, { failSend: true });
  const result = await store.send("wks_1", { agentId: "agent-1", commentIds: [comment.commentId], workspaceName: "W", scopeLabel: "S" }, failing.paseo);
  assert.equal(result.error, "socket closed");
  assert.deepEqual(result.comments[0].delivery, { phase: "sending", error: "socket closed" });
  assert.equal(result.comments[0].status, "open");
  await assert.rejects(store.send("wks_1", { agentId: "agent-1", commentIds: [comment.commentId], workspaceName: "W", scopeLabel: "S" }, fakePaseo({}).paseo), /Only unsent/, "never resent automatically");
  await assert.rejects(store.update("wks_1", comment.commentId, "resolve"), /Confirm/);
  const notSent = await store.update("wks_1", comment.commentId, "confirm-not-sent");
  assert.equal(notSent[0].delivery, null);
  assert.equal(notSent[0].status, "open");
});

test("reviewing from a commit includes that commit, later commits and uncommitted work", async t => {
  const repo = await mkdtemp(join(tmpdir(), "mission-review-from-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args]);
  execFileSync("git", ["init", "-q", repo]);
  await writeFile(join(repo, "base.txt"), "base\n");
  git("add", "."); git("commit", "-q", "-m", "base");
  await writeFile(join(repo, "one.txt"), "one\n");
  git("add", "."); git("commit", "-q", "-m", "first change");
  const first = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await writeFile(join(repo, "two.txt"), "two\n");
  git("add", "."); git("commit", "-q", "-m", "second change");
  await writeFile(join(repo, "three.txt"), "three\n");
  assert.deepEqual((await collectSnapshot(repo)).files.map(file => file.path), ["three.txt"]);
  const from = await collectSnapshot(repo, first);
  assert.equal(from.base, "commit");
  assert.equal(from.fromCommit.commits, 2);
  assert.deepEqual(from.files.map(file => file.path).sort(), ["one.txt", "three.txt", "two.txt"]);
  const unknown = await collectSnapshot(repo, "0123456789abcdef0123456789abcdef01234567");
  assert.match(unknown.baseWarning, /no longer in this branch/);
  assert.deepEqual(unknown.files.map(file => file.path), ["three.txt"]);
  const { listCommits } = require("./review.ts");
  assert.deepEqual((await listCommits(repo)).map(commit => commit.subject), ["second change", "first change", "base"]);
});
