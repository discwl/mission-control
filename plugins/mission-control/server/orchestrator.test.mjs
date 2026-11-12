import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { readOrchestratorBindings } = require("./orchestrator.ts");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mc-orchestrator-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = async (name, file) => {
    const path = join(root, name);
    await mkdir(path, { recursive: true });
    if (file !== undefined) await writeFile(join(path, "host.json"), typeof file === "string" ? file : JSON.stringify(file));
    return path;
  };
  const workspaces = {
    acme: { workspaceDirectory: await folder("Acme", { schemaVersion: 1, label: "Acme", serverId: "srv_acme" }), projectRootPath: root },
    plain: { workspaceDirectory: await folder("plain"), projectRootPath: root },
    vault: { workspaceDirectory: await folder("vault", { schemaVersion: 1, hostId: "personal", serverId: "srv_local" }), projectRootPath: root },
    broken: { workspaceDirectory: await folder("broken", "{"), projectRootPath: root },
    root: { projectRootPath: await folder("project-root", { schemaVersion: 1, label: "Globex", serverId: "srv_globex" }) },
    archived: { workspaceDirectory: await folder("archived", { schemaVersion: 1, label: "Initech", serverId: "srv_initech" }), projectRootPath: root, archivingAt: "2026-10-07T00:00:00Z" },
  };
  // Each direct lookup pages through the whole directory in Paseo's client, so the reads are counted.
  const reads = { refresh: 0, list: 0 };
  let listFails = false;
  const listed = Object.entries(workspaces).map(([id, workspace]) => ({ id, ...workspace }));
  const paseo = { workspaces: {
    ref: id => ({ refresh: async () => {
      reads.refresh++;
      if (id === "fails") throw new Error("daemon unavailable");
      return workspaces[id] ?? null;
    } }),
    list: async ({ page }) => {
      reads.list++;
      if (listFails) throw new Error("daemon unavailable");
      const start = page.cursor ? Number(page.cursor) : 0;
      const entries = listed.slice(start, start + 4);
      const next = start + 4 < listed.length ? String(start + 4) : null;
      return { entries, pageInfo: { hasMore: next !== null, nextCursor: next } };
    },
  } };
  return { paseo, reads, records: listed, failListing: () => { listFails = true; } };
}

test("workspaces whose folder names a remote host are bound to it", async t => {
  const { paseo, reads } = await fixture(t);
  const result = await readOrchestratorBindings(paseo, ["acme", "plain", "vault", "root", "acme"], { localServerId: async () => "srv_local" });
  assert.deepEqual(result, { bindings: { acme: { label: "Acme", serverId: "srv_acme" }, root: { label: "Globex", serverId: "srv_globex" } }, problems: {} });
  // Several workspaces share one paged listing instead of a whole-directory lookup each.
  assert.deepEqual(reads, { refresh: 0, list: 2 });
});

test("records the caller already listed are used as they are, without reading the directory", async t => {
  const { paseo, reads, records } = await fixture(t);
  const result = await readOrchestratorBindings(paseo, records, { localServerId: async () => "srv_local" });
  assert.deepEqual(result.bindings, { acme: { label: "Acme", serverId: "srv_acme" }, root: { label: "Globex", serverId: "srv_globex" } });
  assert.deepEqual(Object.keys(result.problems), ["broken"]);
  assert.deepEqual(reads, { refresh: 0, list: 0 });
});

test("a single workspace is looked up directly; a failed listing of several is passed on, so the caller keeps its last answer", async t => {
  const { paseo, reads, failListing } = await fixture(t);
  assert.deepEqual((await readOrchestratorBindings(paseo, ["acme"], { localServerId: async () => "srv_local" })).bindings, { acme: { label: "Acme", serverId: "srv_acme" } });
  assert.deepEqual(reads, { refresh: 1, list: 0 });
  failListing();
  await assert.rejects(readOrchestratorBindings(paseo, ["acme", "root"], { localServerId: async () => "srv_local" }), /daemon unavailable/);
});

test("workspaces not reached within the listing's page limit are looked up directly, not dropped", async t => {
  const { paseo, reads } = await fixture(t);
  // A directory longer than the page limit, whose pages never reach these workspaces.
  const endless = { workspaces: { ref: paseo.workspaces.ref, list: async () => { reads.list++; return { entries: [], pageInfo: { hasMore: true, nextCursor: "more" } }; } } };
  const result = await readOrchestratorBindings(endless, ["acme", "root"], { localServerId: async () => "srv_local" });
  assert.deepEqual(result.bindings, { acme: { label: "Acme", serverId: "srv_acme" }, root: { label: "Globex", serverId: "srv_globex" } });
  assert.deepEqual(reads, { refresh: 2, list: 10 });
});

test("broken host files are problems; unknown, failing and archived workspaces are left out", async t => {
  const { paseo } = await fixture(t);
  const result = await readOrchestratorBindings(paseo, ["broken", "missing", "fails", "archived"], { localServerId: async () => "srv_local" });
  assert.deepEqual(result.bindings, {});
  assert.deepEqual(Object.keys(result.problems), ["broken"]);
  assert.match(result.problems.broken, /isn't valid JSON/);
});

test("a host file that can't be read for another reason than missing is a problem", async t => {
  const { paseo } = await fixture(t);
  const denied = Object.assign(new Error("access denied"), { code: "EPERM" });
  const result = await readOrchestratorBindings(paseo, ["acme"], { localServerId: async () => "srv_local", readText: async () => { throw denied; } });
  assert.deepEqual(result.bindings, {});
  assert.match(result.problems.acme, /can't be read: access denied/);
});
