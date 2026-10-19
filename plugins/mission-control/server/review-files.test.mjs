import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { collectSnapshot, readMarkdownFile } = require("./review.ts");
const { isMarkdownPath } = require("../shared/review.ts");

async function repository(t) {
  const repo = await mkdtemp(join(tmpdir(), "mission-review-files-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", repo]);
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args]);
  return { repo, git };
}

test("deleted files and empty new files are listed with their kind", async t => {
  const { repo, git } = await repository(t);
  await writeFile(join(repo, "gone.txt"), "one\ntwo\n");
  await writeFile(join(repo, "kept.md"), "# Kept\n");
  git("add", "."); git("commit", "-q", "-m", "base");
  await unlink(join(repo, "gone.txt"));
  await writeFile(join(repo, "empty.txt"), "");
  await writeFile(join(repo, "kept.md"), "# Kept\n\nMore.\n");
  const files = Object.fromEntries((await collectSnapshot(repo)).files.map(file => [file.path, file]));
  assert.equal(files["gone.txt"].change, "deleted");
  assert.equal(files["gone.txt"].deletions, 2);
  assert.equal(files["empty.txt"].change, "added");
  assert.equal(files["empty.txt"].hunks.length, 0);
  assert.equal(files["empty.txt"].reviewIds.length, 1, "an empty file can still be marked reviewed");
  assert.equal(files["kept.md"].change, "modified");
});

test("the preview reader returns Markdown inside the repository and rejects everything else", async t => {
  const { repo } = await repository(t);
  await mkdir(join(repo, "docs"));
  await writeFile(join(repo, "docs", "guide.md"), "# Guide\n\nHello.\n");
  await writeFile(join(repo, "notes.txt"), "not markdown");
  assert.deepEqual(await readMarkdownFile(repo, "docs/guide.md"), { text: "# Guide\n\nHello.\n", truncated: false });
  assert.deepEqual(await readMarkdownFile(join(repo, "docs"), "docs/guide.md"), { text: "# Guide\n\nHello.\n", truncated: false }, "paths are relative to the repository root");
  await assert.rejects(readMarkdownFile(repo, "notes.txt"), /Only Markdown/);
  await assert.rejects(readMarkdownFile(repo, "../outside.md"), /not inside/);
  await assert.rejects(readMarkdownFile(repo, "docs\\..\\..\\outside.md"), /not inside/);
  await assert.rejects(readMarkdownFile(repo, ".git/notes.md"), /not inside/);
  await assert.rejects(readMarkdownFile(repo, join(repo, "docs", "guide.md")), /not inside/);
  await writeFile(join(repo, "..notes.md"), "# Dots\n");
  assert.equal((await readMarkdownFile(repo, "..notes.md")).text, "# Dots\n", "a name starting with two dots is still inside");
});

test("a workspace opened at a subfolder reviews the whole repository with paths from its root", async t => {
  const { repo, git } = await repository(t);
  await mkdir(join(repo, "sub"));
  await writeFile(join(repo, "sub", "kept.md"), "# Kept\n");
  await writeFile(join(repo, "top.md"), "# Top\n");
  git("add", "."); git("commit", "-q", "-m", "base");
  // A subfolder's untracked file and the root's share a name: actions resolve from the root, so they must differ.
  await writeFile(join(repo, "sub", "kept.md"), "# Kept\n\nMore.\n");
  await writeFile(join(repo, "sub", "new.md"), "# New in sub\n");
  await writeFile(join(repo, "new.md"), "# New at the root\n");
  await writeFile(join(repo, "top.md"), "# Top\n\nChanged.\n");
  // diff.relative must neither narrow the review to the subfolder nor change its paths.
  git("config", "diff.relative", "true");
  const snapshot = await collectSnapshot(join(repo, "sub"));
  assert.deepEqual(snapshot.files.map(file => file.path).sort(), ["new.md", "sub/kept.md", "sub/new.md", "top.md"]);
  assert.equal((await readMarkdownFile(join(repo, "sub"), "sub/new.md")).text, "# New in sub\n");
  assert.equal((await readMarkdownFile(join(repo, "sub"), "new.md")).text, "# New at the root\n");
  assert.deepEqual((await collectSnapshot(repo)).files.map(file => file.path).sort(), ["new.md", "sub/kept.md", "sub/new.md", "top.md"], "the same review as from the root");
});

test("only Markdown extensions count as Markdown", () => {
  assert.equal(isMarkdownPath("README.md"), true);
  assert.equal(isMarkdownPath("docs/page.MDX"), true);
  assert.equal(isMarkdownPath("notes.markdown"), true);
  assert.equal(isMarkdownPath("readmemd"), false);
  assert.equal(isMarkdownPath("script.md.ts"), false);
});
