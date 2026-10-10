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
  const paseo = { workspaces: { ref: id => ({ refresh: async () => {
    if (id === "fails") throw new Error("daemon unavailable");
    return workspaces[id] ?? null;
  } }) } };
  return { paseo };
}

test("workspaces whose folder names a remote host are bound to it", async t => {
  const { paseo } = await fixture(t);
  const result = await readOrchestratorBindings(paseo, ["acme", "plain", "vault", "root", "acme"], { localServerId: async () => "srv_local" });
  assert.deepEqual(result, { bindings: { acme: { label: "Acme", serverId: "srv_acme" }, root: { label: "Globex", serverId: "srv_globex" } }, problems: {} });
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
