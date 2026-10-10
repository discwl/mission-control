import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createVaultStore, normalizeVaultPath } from "./vault.ts";

async function fixture(t) {
  const sandbox = await mkdtemp(join(tmpdir(), "mission-vault-test-"));
  const root = join(sandbox, "dev-vault");
  await mkdir(root);
  t.after(async () => {
    const target = resolve(sandbox), base = resolve(tmpdir());
    assert.ok(target.startsWith(`${base}${sep}`) && target.includes("mission-vault-test-"));
    await rm(target, { recursive: true, force: true });
  });
  return { sandbox, root, vault: createVaultStore(root, null) };
}

test("initialization preserves files and distinguishes preparation from app registration", async t => {
  const { root, sandbox } = await fixture(t);
  const registry = join(sandbox, "obsidian.json");
  await writeFile(registry, JSON.stringify({ vaults: {} }));
  const vault = createVaultStore(root, registry);
  assert.deepEqual({ initialized: (await vault.status()).initialized, registered: (await vault.status()).obsidianRegistered }, { initialized: false, registered: false });
  await writeFile(join(root, "README.md"), "Existing content");
  assert.equal((await vault.initialize()).initialized, true);
  const settings = '{"showLineNumber":true}';
  await writeFile(join(root, ".obsidian", "app.json"), settings);
  await vault.initialize();
  assert.equal(await readFile(join(root, ".obsidian", "app.json"), "utf8"), settings);
  assert.equal(await readFile(join(root, "README.md"), "utf8"), "Existing content");
  assert.deepEqual(JSON.parse(await readFile(registry, "utf8")), { vaults: {} });
  await writeFile(registry, JSON.stringify({ vaults: { testVault: { path: root } } }));
  const status = await vault.status();
  assert.equal(status.obsidianRegistered, true);
  assert.equal(status.obsidianVaultId, "testVault");
  const missingRoot = createVaultStore(join(sandbox, "new-vault"), null);
  assert.equal((await missingRoot.status()).exists, false);
  assert.equal((await missingRoot.initialize()).initialized, true);
});

test("browses all vault folders and nested run evidence without a task filter", async t => {
  const { root, vault } = await fixture(t);
  for (const path of ["Daily", "Projects/demo/docs", "Templates", "Tasks/task_abc/runs/old-run"]) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, "Projects/demo/docs/design.md"), "# Design\n");
  await writeFile(join(root, "Tasks/task_abc/runs/old-run/review.md"), "Evidence");
  const entries = (await vault.list("")).entries;
  assert.deepEqual(entries.map(entry => entry.name), ["Daily", "Projects", "Tasks", "Templates"]);
  assert.equal((await vault.read("Projects/demo/docs/design.md")).editable, true);
  const evidence = await vault.read("Tasks/task_abc/runs/old-run/review.md");
  assert.equal(evidence.content, "Evidence");
  assert.equal(evidence.editable, false);
});

test("Markdown edits persist and stale revisions cannot overwrite newer content", async t => {
  const { root, vault } = await fixture(t);
  await vault.create({ path: "Notes", kind: "folder" });
  await vault.create({ path: "Notes/My Note.md", kind: "note" });
  const initial = await vault.read("Notes/My Note.md");
  const saved = await vault.save({ path: initial.path, revision: initial.revision, content: "# Updated\n\nUnicode: café 日本語\n" });
  assert.equal(saved.content, "# Updated\n\nUnicode: café 日本語\n");
  await assert.rejects(vault.save({ path: initial.path, revision: initial.revision, content: "Old draft" }), /changed outside/);
  await writeFile(join(root, initial.path), "Saved by Obsidian");
  await assert.rejects(vault.save({ path: initial.path, revision: saved.revision, content: "Another old draft" }), /changed outside/);
  assert.equal(await readFile(join(root, initial.path), "utf8"), "Saved by Obsidian");
});

test("moves do not replace destinations and trash keeps recoverable contents", async t => {
  const { root, vault } = await fixture(t);
  await vault.create({ path: "Daily", kind: "folder" });
  await vault.create({ path: "Daily/Note.md", kind: "note" });
  await vault.create({ path: "Existing.md", kind: "note" });
  const file = await vault.read("Daily/Note.md");
  await assert.rejects(vault.move({ path: file.path, destination: "Existing.md", revision: file.entryRevision }), /already exists/);
  const moved = await vault.move({ path: file.path, destination: "Daily/Renamed.md", revision: file.entryRevision });
  assert.equal((await vault.read(moved.path)).content, file.content);
  await assert.rejects(lstat(join(root, file.path)), { code: "ENOENT" });
  const folder = (await vault.list("")).entries.find(entry => entry.path === "Daily");
  const result = await vault.trash({ path: "Daily", revision: folder.revision });
  assert.match(result.trashedPath, /^\.trash\/.+\/Daily$/);
  assert.equal(await readFile(join(root, result.trashedPath, "Renamed.md"), "utf8"), file.content);
  assert.equal((await vault.list(".trash")).entries[0].manageable, false);
});

test("task records, task identities, host settings and run evidence are protected", async t => {
  const { root, vault } = await fixture(t);
  await mkdir(join(root, "Tasks/task_abc/runs/run1"), { recursive: true });
  await mkdir(join(root, ".obsidian"));
  const paths = ["host.json", ".obsidian/README.md", "Tasks/task_abc/task.md", "Tasks/task_def.md", "Tasks/task_abc/runs/run1/review.md"];
  for (const path of paths) {
    await writeFile(join(root, path), "Keep");
    const item = await vault.read(path);
    assert.equal(item.manageable, false, path);
    assert.equal(item.editable, false, path);
    await assert.rejects(vault.save({ path, revision: item.revision, content: "Changed" }));
    await assert.rejects(vault.move({ path, destination: "Elsewhere.md", revision: item.entryRevision }));
    await assert.rejects(vault.trash({ path, revision: item.entryRevision }));
    assert.equal(await readFile(join(root, path), "utf8"), "Keep");
  }
  const tasks = (await vault.list("")).entries.find(entry => entry.path === "Tasks");
  await assert.rejects(vault.trash({ path: "Tasks", revision: tasks.revision }), /Task folders/);
  const task = (await vault.list("Tasks")).entries.find(entry => entry.path === "Tasks/task_abc");
  await assert.rejects(vault.move({ path: task.path, destination: "Archived task", revision: task.revision }), /Task folders/);
  const note = await vault.create({ path: "Tasks/task_abc/design.md", kind: "note" });
  assert.equal(note.editable, true);
  assert.equal((await vault.locateTask("task_abc")).path, "Tasks/task_abc/task.md");
  assert.equal((await vault.locateTask("task_def")).path, "Tasks/task_def.md");
});

test("rejects traversal, absolute paths, Windows aliases and linked directory escapes", async t => {
  const { root, sandbox, vault } = await fixture(t);
  for (const path of ["../escape", "/absolute", "C:\\outside.md", "foo/../bar", "a//b", "a/", "NUL.md", "a/COM1", "note.md:stream", "folder. /note.md", "foo\\..\\bar"]) assert.throws(() => normalizeVaultPath(path), /relative path/, path);
  assert.equal(normalizeVaultPath("Daily\\My Note.md"), "Daily/My Note.md");
  const outside = join(sandbox, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "private.md"), "Outside vault");
  await symlink(outside, join(root, "Linked"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await vault.list("")).entries[0].kind, "link");
  await assert.rejects(vault.list("Linked"), /Linked files/);
  await assert.rejects(vault.read("Linked/private.md"), /Linked files/);
  await assert.rejects(vault.create({ path: "Linked/New.md", kind: "note" }), /Linked files/);
  await assert.rejects(createVaultStore(join(root, "Linked"), null).initialize(), /real folder/);
  assert.equal(await readFile(join(outside, "private.md"), "utf8"), "Outside vault");
});

test("honors task writer locks and refuses stale move or trash requests", async t => {
  const { root, vault } = await fixture(t);
  await mkdir(join(root, "Tasks/task_abc"), { recursive: true });
  await writeFile(join(root, "Tasks/task_abc/notes.md"), "Original");
  const note = await vault.read("Tasks/task_abc/notes.md");
  const lock = join(root, "Tasks/task_abc/.mission-control-write.lock");
  await writeFile(lock, "");
  await assert.rejects(vault.save({ path: note.path, revision: note.revision, content: "New" }), /being updated/);
  assert.equal(await readFile(join(root, note.path), "utf8"), "Original");
  await rm(lock);
  await writeFile(join(root, note.path), "Longer replacement");
  await assert.rejects(vault.move({ path: note.path, destination: "Elsewhere.md", revision: note.entryRevision }), /This item changed/);
  await assert.rejects(vault.trash({ path: note.path, revision: note.entryRevision }), /This item changed/);
});

test("previews supported files with bounded sizes and leaves other files visible", async t => {
  const { root, vault } = await fixture(t);
  await writeFile(join(root, "data.json"), '{"value":1}');
  await writeFile(join(root, "large.md"), "x".repeat(200_001));
  await writeFile(join(root, "diagram.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  await writeFile(join(root, "manual.pdf"), "%PDF");
  assert.equal((await vault.read("data.json")).preview, "text");
  assert.equal((await vault.read("data.json")).editable, false);
  assert.equal((await vault.read("large.md")).preview, "unsupported");
  assert.match((await vault.read("diagram.png")).dataUrl, /^data:image\/png;base64,/);
  assert.equal((await vault.read("manual.pdf")).preview, "unsupported");
  assert.equal((await vault.list("")).entries.length, 4);
  await vault.create({ path: "Note.md", kind: "note" });
  const note = await vault.read("Note.md");
  await assert.rejects(vault.save({ path: note.path, revision: note.revision, content: "界".repeat(70_000) }), /200 KB/);
});
