import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { test } from "node:test";
const require = createRequire(import.meta.url), ts = require("typescript");
function load(name, local) {
  const compiled = ts.transpileModule(readFileSync(new URL(name, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(id => id.startsWith("node:") ? require(id) : local[id] ?? (() => { throw new Error(`Unexpected import ${id}`); })(), module, module.exports);
  return module.exports;
}
const review = load("./review.ts", { "../shared/review": { isMarkdownPath: path => /\.md$/i.test(path) }, "./review-diff": {}, "./review-rules": {} });
const actions = load("./review-actions.ts", { "./review": review });
const git = review.runGit;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mission-review-actions-"));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("mission-review-actions-"));
    await rm(root, { recursive: true, force: true });
  });
  await git(root, ["init"]); await git(root, ["config", "core.autocrlf", "false"]); await git(root, ["config", "user.email", "test@example.invalid"]); await git(root, ["config", "user.name", "Review tests"]);
  await mkdir(join(root, "src")); await writeFile(join(root, "src", "file.txt"), "original\n");
  await writeFile(join(root, "other.txt"), "other\n"); await git(root, ["add", "."]); await git(root, ["commit", "-m", "fixture"]);
  return root;
}

test("copy-path RPC resolves files, folders and deleted files only in the selected host/workspace", async t => {
  const root = await fixture(t), handlers = new Map(), seen = [];
  const rpc = load("./review-rpc.ts", {
    "../shared/review": new Proxy({}, { get: (_target, name) => name }),
    "./review-actions": actions, "./review": review,
    "./review-marks": { createReviewMarkStore: () => ({}) },
    "./review-comments": { createReviewCommentStore: () => ({}) },
    "./tasks": { localServerId: async () => "personal" },
  });
  rpc.registerReview({ handle: (name, handler) => handlers.set(name, handler) }, root);
  const resolvePath = handlers.get("resolveReviewItemPath"); assert.equal(typeof resolvePath, "function");
  const paseo = { workspaces: { ref(id) { seen.push(id); return { refresh: async () => id === "current" ? { workspaceDirectory: root } : null }; } } };
  const input = { serverId: "personal", workspaceId: "current", path: "src/file.txt", directory: false };
  const canonicalRoot = await (await import("node:fs/promises")).realpath(root);
  assert.deepEqual(await resolvePath(input, { paseo }), { path: join(canonicalRoot, "src", "file.txt") });
  assert.deepEqual(await resolvePath({ ...input, path: "src", directory: true }, { paseo }), { path: join(canonicalRoot, "src") });
  await rm(join(root, "src", "file.txt"));
  assert.deepEqual(await resolvePath(input, { paseo }), { path: join(canonicalRoot, "src", "file.txt") });
  const before = seen.length;
  await assert.rejects(resolvePath({ ...input, serverId: "other-host" }, { paseo }), /this Mission Control host only/);
  assert.equal(seen.length, before);
  await assert.rejects(resolvePath({ ...input, workspaceId: "missing" }, { paseo }), /not available/);
  await assert.rejects(resolvePath({ ...input, path: "../outside" }, { paseo }), /not inside/);
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "other\n");
});

test("discard restores staged and unstaged content without touching another file", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "src", "file.txt"), "staged\n"); await git(root, ["add", "src/file.txt"]);
  await writeFile(join(root, "src", "file.txt"), "unstaged\n"); await writeFile(join(root, "other.txt"), "keep me\n");
  const plan = await actions.planReviewDiscard(root, "src/file.txt", false);
  assert.deepEqual(plan.paths, ["src/file.txt"]); assert.deepEqual(plan.removePaths, []);
  await actions.applyReviewDiscard(root, "src/file.txt", false, plan.token);
  assert.equal(await readFile(join(root, "src", "file.txt"), "utf8"), "original\n");
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "keep me\n");
  assert.equal(await git(root, ["diff", "--cached", "--", "src/file.txt"]), "");
});

test("folder discard lists and deletes only its staged/untracked additions", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "src", "new.txt"), "new\n"); await git(root, ["add", "src/new.txt"]);
  await writeFile(join(root, "src", "untracked.txt"), "untracked\n");
  await mkdir(join(root, "src-other")); await writeFile(join(root, "src-other", "keep.txt"), "keep\n");
  const plan = await actions.planReviewDiscard(root, "src/", true);
  assert.deepEqual(plan.paths, ["src/new.txt", "src/untracked.txt"]);
  assert.deepEqual(plan.removePaths, plan.paths);
  await actions.applyReviewDiscard(root, "src/", true, plan.token);
  await assert.rejects(readFile(join(root, "src", "new.txt")), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "src", "untracked.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(root, "src-other", "keep.txt"), "utf8"), "keep\n");
});

test("a rename includes both endpoints even when they span folders", async t => {
  const root = await fixture(t); await git(root, ["mv", "src/file.txt", "moved.txt"]);
  const plan = await actions.planReviewDiscard(root, "moved.txt", false);
  assert.deepEqual(plan.paths, ["moved.txt", "src/file.txt"]);
  await actions.applyReviewDiscard(root, "moved.txt", false, plan.token);
  assert.equal(await readFile(join(root, "src", "file.txt"), "utf8"), "original\n");
  await assert.rejects(readFile(join(root, "moved.txt")), { code: "ENOENT" });
});

test("intervening binary edits invalidate confirmation despite unchanged status", async t => {
  const root = await fixture(t); await writeFile(join(root, "src", "file.txt"), Buffer.from([0, 1, 2]));
  const plan = await actions.planReviewDiscard(root, "src/file.txt", false);
  await writeFile(join(root, "src", "file.txt"), Buffer.from([0, 1, 3]));
  await assert.rejects(actions.applyReviewDiscard(root, "src/file.txt", false, plan.token), /changed after confirmation/);
  assert.deepEqual(await readFile(join(root, "src", "file.txt")), Buffer.from([0, 1, 3]));
});

test("index-only changes invalidate confirmation even when the working file is unchanged", async t => {
  const root = await fixture(t); await writeFile(join(root, "src", "file.txt"), "one\n"); await git(root, ["add", "src/file.txt"]);
  await writeFile(join(root, "src", "file.txt"), "two\n");
  const plan = await actions.planReviewDiscard(root, "src/file.txt", false);
  await git(root, ["add", "src/file.txt"]);
  await assert.rejects(actions.applyReviewDiscard(root, "src/file.txt", false, plan.token), /changed after confirmation/);
  assert.equal(await readFile(join(root, "src", "file.txt"), "utf8"), "two\n");
});

test("absolute, traversal and Git metadata paths are refused", () => {
  for (const path of ["../other", "src/../other", "/tmp/file", "C:\\file", "\\\\server\\share", ".git/config", "src/.GIT/config", "a\0b", "src//file", ".", "src/file:stream", ".git./config", ".git /config"])
    assert.throws(() => actions.checkReviewPath(path), /not inside/);
  assert.equal(actions.checkReviewPath("src\\file.txt"), "src/file.txt");
});

test("symlink ancestors cannot be read, revealed or discarded", async t => {
  const root = await fixture(t); await symlink(join(root, "src"), join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(actions.checkedReviewPath(root, "linked/file.txt"), /symbolic links/);
});

test("deleted files restore safely and committed-only files are not discardable", async t => {
  const root = await fixture(t); await rm(join(root, "src", "file.txt"));
  const plan = await actions.planReviewDiscard(root, "src/file.txt", false);
  await actions.applyReviewDiscard(root, "src/file.txt", false, plan.token);
  assert.equal(await readFile(join(root, "src", "file.txt"), "utf8"), "original\n");
  await assert.rejects(actions.planReviewDiscard(root, "src/file.txt", false), /no uncommitted/);
});

test("text open is bounded and binary contents receive clear feedback", async t => {
  const root = await fixture(t);
  assert.deepEqual(await actions.readReviewText(root, "src/file.txt"), { text: "original\n", truncated: false });
  await writeFile(join(root, "src", "file.txt"), "x".repeat(512 * 1024 + 4));
  const content = await actions.readReviewText(root, "src/file.txt"); assert.equal(content.text.length, 512 * 1024); assert.equal(content.truncated, true);
  await writeFile(join(root, "src", "file.txt"), Buffer.from([0, 1]));
  await assert.rejects(actions.readReviewText(root, "src/file.txt"), /binary file/);
});

test("host/workspace ownership is checked before reading an owning repository", async t => {
  const root = await fixture(t); let reads = 0;
  const paseo = { workspaces: { ref(id) { assert.equal(id, "current-workspace"); return { refresh: async () => { reads++; return { workspaceDirectory: root }; } }; } } };
  await assert.rejects(actions.reviewRoot(paseo, "personal", { serverId: "other", workspaceId: "current-workspace" }), /this Mission Control host only/);
  assert.equal(reads, 0);
  assert.equal(await actions.reviewRoot(paseo, "personal", { serverId: "personal", workspaceId: "current-workspace" }), await (await import("node:fs/promises")).realpath(root));
  await assert.rejects(actions.reviewRoot({ workspaces: { ref: () => ({ refresh: async () => null }) } }, "personal", { serverId: "personal", workspaceId: "missing" }), /not available/);
});

test("Explorer reveal uses literal arguments on the owning host; no shell or execution", async t => {
  const root = await fixture(t), launches = []; let released = 0;
  const launch = (...args) => { launches.push(args); const child = new EventEmitter(); child.unref = () => { released++; }; queueMicrotask(() => child.emit("spawn")); return child; };
  await actions.revealReviewPath(root, "src/file.txt", false, launch, "win32");
  assert.deepEqual(launches[0], ["explorer.exe", ["/select,", join(root, "src", "file.txt")], { windowsHide: false, detached: true, stdio: "ignore" }]);
  await actions.revealReviewPath(root, "src", true, launch, "win32");
  assert.deepEqual(launches[1][1], [join(root, "src")]);
  await assert.rejects(actions.revealReviewPath(root, "src", true, launch, "linux"), /Windows hosts only/);
  assert.equal(launches.length, 2);
  assert.equal(released, 2);
});

test("working-file image responses preserve bytes, detect formats and enforce the preview limit", async t => {
  const root = await fixture(t);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9b0AAAAASUVORK5CYII=", "base64");
  for (const [mimeType, bytes] of [["image/png", png], ["image/jpeg", Buffer.from([255, 216, 255, 0])], ["image/gif", Buffer.from("GIF89a\0")], ["image/webp", Buffer.from("RIFF\0\0\0\0WEBP")]]) {
    await writeFile(join(root, "src", "file.txt"), bytes);
    assert.deepEqual(await actions.readReviewText(root, "src/file.txt"), { text: "", truncated: false, image: { mimeType, base64: bytes.toString("base64") } });
  }
  const large = Buffer.alloc(2 * 1024 * 1024 + 1); png.copy(large);
  await writeFile(join(root, "src", "file.txt"), large);
  await assert.rejects(actions.readReviewText(root, "src/file.txt"), /2 MB preview limit/);
});

test("working-file RPC reads the exact workspace image and refuses other hosts or missing workspaces", async t => {
  const root = await fixture(t), handlers = new Map();
  const rpc = load("./review-rpc.ts", {
    "../shared/review": new Proxy({}, { get: (_target, name) => name }),
    "./review-actions": actions, "./review": review,
    "./review-marks": { createReviewMarkStore: () => ({}) },
    "./review-comments": { createReviewCommentStore: () => ({}) },
    "./tasks": { localServerId: async () => "personal" },
  });
  rpc.registerReview({ handle: (name, handler) => handlers.set(name, handler) }, root);
  const read = handlers.get("readReviewWorkingFile");
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(join(root, "src", "image.png"), image);
  const paseo = { workspaces: { ref: id => ({ refresh: async () => id === "current" ? { workspaceDirectory: root } : null }) } };
  const input = { serverId: "personal", workspaceId: "current", path: "src/image.png" };
  assert.equal((await read(input, { paseo })).image.base64, image.toString("base64"));
  await assert.rejects(read({ ...input, serverId: "other-host" }, { paseo }), /this Mission Control host only/);
  await assert.rejects(read({ ...input, workspaceId: "missing" }, { paseo }), /not available/);
  await assert.rejects(read({ ...input, path: "src/missing.png" }, { paseo }), /ENOENT/);
});

test("Explorer handles literal spaces, deleted files and launch errors", async t => {
  const root = await fixture(t), launches = [];
  const launch = (...args) => { launches.push(args); const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit("spawn")); return child; };
  await writeFile(join(root, "src", "résumé & notes.txt"), "text");
  await actions.revealReviewPath(root, "src/résumé & notes.txt", false, launch, "win32");
  assert.deepEqual(launches[0][1], ["/select,", join(root, "src", "résumé & notes.txt")]);
  await actions.revealReviewPath(root, "src/deleted.txt", false, launch, "win32");
  assert.deepEqual(launches[1][1], [join(root, "src")]);
  const broken = () => { const child = new EventEmitter(); queueMicrotask(() => child.emit("error", new Error("ENOENT"))); return child; };
  await assert.rejects(actions.revealReviewPath(root, "src", true, broken, "win32"), /Could not open Windows Explorer: ENOENT/);
});

test("literal pathspec filenames discard only the selected file", async t => {
  const root = await fixture(t);
  await writeFile(join(root, "[abc].txt"), "remove\n"); await writeFile(join(root, "a.txt"), "keep\n");
  const plan = await actions.planReviewDiscard(root, "[abc].txt", false);
  await actions.applyReviewDiscard(root, "[abc].txt", false, plan.token);
  await assert.rejects(readFile(join(root, "[abc].txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(root, "a.txt"), "utf8"), "keep\n");
});

test("merge-conflicted files cannot be discarded through the review action", async t => {
  const root = await fixture(t), branch = (await git(root, ["branch", "--show-current"])).trim();
  await git(root, ["checkout", "-b", "other"]); await writeFile(join(root, "src", "file.txt"), "other branch\n"); await git(root, ["commit", "-am", "other"]);
  await git(root, ["checkout", branch]); await writeFile(join(root, "src", "file.txt"), "main branch\n"); await git(root, ["commit", "-am", "main"]);
  await git(root, ["merge", "other"], [1]);
  await assert.rejects(actions.planReviewDiscard(root, "src/file.txt", false), /merge conflicts/);
  assert.match(await readFile(join(root, "src", "file.txt"), "utf8"), /<<<<<<< HEAD/);
});
