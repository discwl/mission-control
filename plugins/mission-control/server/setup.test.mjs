import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
const { MARKER, assertRunnable, compareVersions, createSetupService, findExecutable, parseVersion, runExecutable, samePath, scrubOutput } = require("./setup.ts");
const { setupManifest } = require("../shared/setup.ts");

// Everything below happens in temporary folders; nothing on this machine is installed or changed.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function write(path, content = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A host with a vault, a kit, provider folders, npm globals, Paseo and Obsidian, all under one temporary root. */
function fixture(t, { serverId = "srv_A", ocrVersion = "1.12.8", versions = {}, replyWithinMs = 20_000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mc-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const vault = join(root, "vault");
  const kit = join(root, "kit");
  const bin = join(root, "bin");
  const appData = join(root, "appdata");
  const localAppData = join(root, "localappdata");
  // Kit: two skills, the CLI, OCR kit files and the delegate skill, and a .git folder (a developer checkout).
  write(join(kit, "skills", "plan-task", "SKILL.md"), "---\nname: plan-task\n---\n");
  write(join(kit, "skills", "write-handoff", "SKILL.md"), "---\nname: write-handoff\n---\n");
  write(join(kit, "skills", "notes", "README.md"), "not a skill");
  write(join(kit, "scripts", "dev-flow.mjs"), "");
  mkdirSync(join(kit, ".git"));
  for (const file of setupManifest.ocr.files) write(join(kit, file.source), `kit copy of ${file.path}\n`);
  write(join(kit, setupManifest.skills.delegate.source, "SKILL.md"), "---\nname: open-code-review-delegate\n---\n");
  // Vault.
  write(join(vault, "host.json"), JSON.stringify({ serverId: "srv_A", hostId: "personal", schemaVersion: 1 }));
  write(join(vault, "Projects", "dev.md"), `---\nschemaVersion: 1\nprojectId: "prj_1"\nkitRoot: ${JSON.stringify(kit)}\n---\n`);
  write(join(vault, "Projects", "readme.md"), "# Not a profile\n");
  // Provider skill folders: OpenCode's is missing.
  for (const folder of [".claude/skills", ".codex/skills", ".copilot/skills"]) mkdirSync(join(home, ...folder.split("/")), { recursive: true });
  // Executables are empty files; the fake runner answers for them.
  for (const name of ["node.exe", "git.exe", "gortex.exe"]) write(join(name === "gortex.exe" ? join(localAppData, "Programs", "gortex") : bin, name));
  write(join(bin, "gh.cmd"), "");
  write(join(bin, "node_modules", "npm", "package.json"), JSON.stringify({ version: "10.9.2" }));
  write(join(bin, "node_modules", "npm", "bin", "npm-cli.js"), "");
  write(join(localAppData, "Programs", "Paseo", "Paseo.exe"));
  const globals = join(appData, "npm", "node_modules");
  if (ocrVersion) write(join(globals, "@alibaba-group", "open-code-review", "package.json"), JSON.stringify({ version: ocrVersion }));
  write(join(globals, "@anthropic-ai", "claude-code", "package.json"), JSON.stringify({ version: "2.1.283" }));
  // Obsidian: app, CLI launcher, settings with the CLI turned on and the vault registered.
  write(join(localAppData, "Programs", "Obsidian", "Obsidian.exe"));
  write(join(localAppData, "Programs", "Obsidian", "Obsidian.com"));
  write(join(appData, "obsidian", "obsidian-1.12.7.asar"));
  write(join(appData, "obsidian", "obsidian-1.13.7.asar"));
  write(join(appData, "obsidian", "obsidian.json"), JSON.stringify({ cli: true, vaults: { abc: { path: vault } } }));

  const calls = [];
  const outputs = { "node.exe": "v22.14.0\n", "git.exe": "git version 2.35.3.windows.1\n", "gortex.exe": "gortex v0.64.5+3310720\n  commit: 3310720\n", "Paseo.exe": "0.9.2\n", ...versions };
  const host = {
    home, vaultRoot: vault, platform: "win32", dataDir: join(root, "paseo", "plugin-data", "mission-control"),
    env: { PATH: bin, APPDATA: appData, LOCALAPPDATA: localAppData },
    now: () => new Date("2026-09-26T12:00:00Z"),
    serverId: async () => serverId,
    install: null,
    async run(file, args, options) {
      calls.push({ file, args, options });
      const name = file.split(/[\\/]/).pop();
      if (args.includes("install")) return host.install(file, args);
      const output = outputs[name];
      if (output instanceof Error) throw output;
      return { code: 0, stdout: output ?? "", stderr: "" };
    },
  };
  return { root, home, vault, kit, bin, appData, localAppData, globals, host, calls, service: createSetupService(host, setupManifest, { replyWithinMs }) };
}

const byId = (items, id) => items.find(entry => entry.id === id);
const group = (report, provider, name = "development-flow") => report.skills.find(entry => entry.provider === provider && entry.group === name);

// ---------- helpers ----------

test("versions are read from command output and compared numerically", () => {
  assert.equal(parseVersion("git version 2.35.3.windows.1"), "2.35.3");
  assert.equal(parseVersion("v22.14.0"), "22.14.0");
  assert.equal(parseVersion("gortex v0.64.5+3310720"), "0.64.5");
  assert.equal(parseVersion("1.12"), "1.12.0");
  assert.equal(parseVersion("no version"), null);
  assert.ok(compareVersions("22.14.0", "22.0.0") > 0);
  assert.ok(compareVersions("0.9.10", "0.9.2") > 0);
  assert.equal(compareVersions("1.12.9", "1.12.9"), 0);
  assert.ok(compareVersions("21.9.9", "22.0.0") < 0);
});

test("only full-path executables run: never a .cmd, .bat or .ps1 launcher", () => {
  assert.doesNotThrow(() => assertRunnable("C:\\Program Files\\nodejs\\node.exe", "win32"));
  for (const file of ["C:\\Users\\me\\AppData\\Roaming\\npm\\npm.cmd", "C:\\x\\run.bat", "C:\\x\\ocr.ps1", "C:\\x\\ocr"]) {
    assert.throws(() => assertRunnable(file, "win32"), /need a shell/);
  }
  assert.throws(() => assertRunnable("node.exe", "win32"), /full path/);
  assert.throws(() => assertRunnable("/usr/local/bin/tool.sh", "linux"), /need a shell/);
  assert.doesNotThrow(() => assertRunnable("/usr/bin/git", "linux"));
});

test("runExecutable runs without a shell and stops at its timeout", async () => {
  const platform = process.platform === "win32" ? "win32" : "linux";
  const ok = await runExecutable(process.execPath, ["-e", "process.stdout.write('v1.2.3 & echo not-a-shell')"], { timeoutMs: 10_000 }, platform);
  assert.equal(ok.code, 0);
  // With a shell, "&" would have started a second command.
  assert.equal(ok.stdout, "v1.2.3 & echo not-a-shell");
  const failed = await runExecutable(process.execPath, ["-e", "process.exit(3)"], { timeoutMs: 10_000 }, platform);
  assert.equal(failed.code, 3);
  await assert.rejects(runExecutable(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 300 }, platform), /didn't finish within/);
});

test("command output is scrubbed of token-like strings before it is kept", () => {
  const output = scrubOutput("added 3 packages\nnpm notice //registry.npmjs.org/:_authToken=npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789\nAuthorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
  assert.match(output, /added 3 packages/);
  assert.doesNotMatch(output, /npm_AbCd|ghp_abcd/);
  assert.match(output, /\[key hidden\]/);
  assert.equal(scrubOutput("  \n"), null);
  // A key cut by the length limit keeps no tail: it is hidden before the output is shortened.
  const key = "npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  const straddling = scrubOutput(`${key} ${"done. ".repeat(330)}`);
  assert.doesNotMatch(straddling, new RegExp(key.slice(-12)));
  assert.ok(straddling.length <= 2001);
  assert.ok(scrubOutput("x".repeat(5000)).length <= 2001);
});

test("executables are found as .exe on PATH or in the manifest's extra folders; launchers are skipped", async t => {
  const { bin, localAppData, host } = fixture(t);
  assert.equal(await findExecutable(host, "node"), join(bin, "node.exe"));
  assert.equal(await findExecutable(host, "gh"), null, "gh.cmd needs a shell, so gh counts as missing");
  assert.equal(await findExecutable(host, "gortex"), null);
  assert.equal(await findExecutable(host, "gortex", [{ env: "LOCALAPPDATA", path: "Programs/gortex" }]), join(localAppData, "Programs", "gortex", "gortex.exe"));
  assert.ok(samePath("\\\\?\\C:\\Kit\\Skills\\", "c:/kit/skills", "win32"));
});

// ---------- detection ----------

test("detection reports each dependency's status and version", async t => {
  const { host, service, calls, vault, kit } = fixture(t);
  const report = await service.read(async () => ({ entries: [{ provider: "claude", status: "ready" }, { provider: "codex", status: "unavailable", enabled: false }] }));

  assert.equal(report.paseo.status, "installed");
  assert.equal(report.paseo.version, "0.9.2");
  assert.equal(report.paseo.expected, "≥ 0.9.1");
  const paseoCall = calls.find(call => call.file.endsWith("Paseo.exe"));
  assert.equal(paseoCall.options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(paseoCall.args.at(-1), "--version");

  assert.deepEqual(report.vault, { root: vault, exists: true, hostJson: { status: "installed", detail: "Matches this host (srv_A, host personal)." } });
  assert.equal(report.kit.root, kit);
  assert.equal(report.kit.profiles.length, 1, "notes in Projects without a projectId aren't profiles");
  assert.equal(report.kit.profiles[0].status, "installed");
  assert.equal(report.kit.profiles[0].developerCheckout, true);
  assert.match(report.kit.profiles[0].detail, /Developer checkout/);

  const tools = report.tools;
  assert.deepEqual([byId(tools, "node").status, byId(tools, "node").version], ["installed", "22.14.0"]);
  assert.deepEqual([byId(tools, "npm").status, byId(tools, "npm").version], ["installed", "10.9.2"]);
  assert.deepEqual([byId(tools, "git").status, byId(tools, "git").version], ["installed", "2.35.3"]);
  assert.equal(byId(tools, "gh").status, "missing");
  assert.equal(byId(tools, "gh").help.command, "winget install --id GitHub.cli");
  assert.deepEqual([byId(tools, "gortex").status, byId(tools, "gortex").version], ["installed", "0.64.5"]);
  assert.deepEqual([byId(tools, "ocr").status, byId(tools, "ocr").version, byId(tools, "ocr").expected], ["outdated", "1.12.8", "pinned 1.12.9"]);
  assert.equal(byId(tools, "ocr").installable, true);
  assert.equal(byId(tools, "ocr-rules").status, "missing");
  assert.deepEqual([byId(tools, "obsidian").status, byId(tools, "obsidian").version], ["installed", "1.13.7"]);
  assert.match(byId(tools, "obsidian").detail, /is registered/);
  assert.equal(byId(tools, "obsidian-cli").status, "installed");
  assert.ok(!calls.some(call => /obsidian/i.test(call.file)), "Obsidian is never started");

  assert.equal(byId(report.providers, "claude").status, "installed");
  assert.match(byId(report.providers, "claude").detail, /Paseo: ready/);
  assert.equal(byId(report.providers, "codex").status, "missing");
  assert.match(byId(report.providers, "codex").detail, /Paseo: turned off/);
  assert.equal(byId(report.providers, "claude").installable, false);

  assert.equal(group(report, "claude").status, "missing");
  assert.deepEqual(group(report, "claude").links.map(link => link.name), ["plan-task", "write-handoff"], "only folders with a SKILL.md are kit skills");
  assert.equal(group(report, "opencode").status, "missing");
  assert.match(group(report, "opencode").blocked, /doesn't exist/);
  assert.equal(group(report, "claude", "ocr-delegate").links[0].target, join(kit, setupManifest.skills.delegate.source));
  assert.deepEqual(report.log, []);
  assert.ok(calls.every(call => /\.exe$/i.test(call.file)));
  assert.ok(!existsSync(host.dataDir), "reading writes nothing");
});

test("detection reports outdated, missing and unknown states", async t => {
  const { service, globals, vault } = fixture(t, { serverId: "srv_B", ocrVersion: null, versions: { "node.exe": "v20.11.1\n", "git.exe": new Error("git.exe didn't finish within 15 seconds.") } });
  rmSync(join(globals, "@anthropic-ai"), { recursive: true });
  const report = await service.read();
  assert.equal(report.vault.hostJson.status, "modified");
  assert.match(report.vault.hostJson.detail, /names srv_A, but this host is srv_B/);
  assert.deepEqual([byId(report.tools, "node").status, byId(report.tools, "node").expected], ["outdated", "≥ 22.0.0"]);
  assert.equal(byId(report.tools, "git").status, "unknown");
  assert.match(byId(report.tools, "git").detail, /didn't finish/);
  assert.equal(byId(report.tools, "ocr").status, "missing");
  assert.equal(byId(report.providers, "claude").status, "missing");
  assert.doesNotMatch(byId(report.providers, "claude").detail, /Paseo:/, "no Paseo client, no provider status");

  rmSync(join(vault, "host.json"));
  assert.equal((await service.read()).vault.hostJson.status, "missing");
});

test("a tool that updates itself reports the newest version it downloaded", async t => {
  const { service, globals, localAppData } = fixture(t);
  write(join(globals, "@github", "copilot", "package.json"), JSON.stringify({ version: "1.0.44" }));
  let copilot = byId((await service.read()).providers, "copilot");
  assert.deepEqual([copilot.status, copilot.version], ["installed", "1.0.44"]);
  for (const version of ["1.0.44", "1.0.80", "1.0.9", "tmp"]) mkdirSync(join(localAppData, "copilot", "pkg", "win32-x64", version), { recursive: true });
  copilot = byId((await service.read()).providers, "copilot");
  assert.equal(copilot.version, "1.0.80");
  assert.match(copilot.detail, /Updated itself: .*1\.0\.80 \(npm package 1\.0\.44\)/);
});

test("a kit without the delegate skill offers no delegate link", async t => {
  const { service, kit } = fixture(t);
  rmSync(join(kit, setupManifest.skills.delegate.source), { recursive: true });
  const delegate = group(await service.read(), "claude", "ocr-delegate");
  assert.equal(delegate.status, "unknown");
  assert.match(delegate.blocked, /has no .*SKILL\.md yet/);
  const plan = await service.plan({ kind: "skills", provider: "claude", group: "ocr-delegate" });
  assert.ok(plan.blocked);
});

test("a missing kit or conflicting profiles disable links and rule files", async t => {
  const { service, vault, root } = fixture(t);
  write(join(vault, "Projects", "other.md"), `---\nprojectId: "prj_2"\nkitRoot: ${JSON.stringify(join(root, "gone"))}\n---\n`);
  let report = await service.read();
  assert.equal(report.kit.profiles.find(profile => profile.projectId === "prj_2").status, "missing");
  assert.ok(report.kit.root, "a profile whose kit is missing doesn't count");

  mkdirSync(join(root, "kit2", "skills"), { recursive: true });
  write(join(root, "kit2", "scripts", "dev-flow.mjs"));
  write(join(vault, "Projects", "other.md"), `---\nprojectId: "prj_2"\nkitRoot: ${JSON.stringify(join(root, "kit2"))}\n---\n`);
  report = await service.read();
  assert.equal(report.kit.profiles.find(profile => profile.projectId === "prj_2").developerCheckout, false);
  assert.equal(report.kit.root, null);
  assert.match(report.kit.rootNote, /different kits/);
  assert.equal(group(report, "claude").status, "unknown");
  assert.equal(byId(report.tools, "ocr-rules").status, "unknown");
  const plan = await service.plan({ kind: "ocr-rules" });
  assert.match(plan.blocked, /different kits/);
  await assert.rejects(service.apply({ kind: "ocr-rules" }, plan.fingerprint), /different kits/);
});

test("a profile whose filename launch would skip is flagged and doesn't count as a kit", async t => {
  const { service, vault, root } = fixture(t);
  mkdirSync(join(root, "kit2", "skills"), { recursive: true });
  write(join(root, "kit2", "scripts", "dev-flow.mjs"));
  write(join(vault, "Projects", "api-2.0.md"), `---\nprojectId: "prj_2"\nkitRoot: ${JSON.stringify(join(root, "kit2"))}\n---\n`);
  const report = await service.read();
  const flagged = report.kit.profiles.find(profile => profile.projectId === "prj_2");
  assert.equal(flagged.status, "modified");
  assert.match(flagged.detail, /ignores this profile/);
  assert.ok(report.kit.root, "its kit doesn't conflict with the correctly named profile's kit");
});

test("a profile naming one managed install moves to the stable kit path, which follows the next update", async t => {
  const { service, vault, root } = fixture(t);
  const installs = join(root, "paseo", "plugins", "mission-control");
  const install = id => {
    const checkout = join(installs, id, "checkout");
    write(join(checkout, "scripts", "dev-flow.mjs"));
    write(join(checkout, "skills", "plan-task", "SKILL.md"), "---\nname: plan-task\n---\n");
    return checkout;
  };
  const profile = join(vault, "Projects", "dev.md");
  const first = install("first");
  write(profile, `---\nschemaVersion: 1\nprojectId: "prj_1"\nkitRoot: ${JSON.stringify(first)}\n---\n\n# Dev\n`);

  let report = await service.read();
  const stable = report.kit.stable;
  assert.equal(stable.status, "installed");
  assert.equal(samePath(readlinkSync(stable.path), first, "win32"), true, "the link points at the only install");
  assert.deepEqual(stable.profilesToMove, [profile]);

  const plan = await service.plan({ kind: "kit-root" });
  assert.equal(plan.blocked, null);
  assert.deepEqual(plan.changes.map(change => [change.path, change.change]), [[profile, "update-file"]]);
  const result = await service.apply({ kind: "kit-root" }, plan.fingerprint);
  assert.equal(result.ok, true);
  const rewritten = readFileSync(profile, "utf8");
  assert.ok(rewritten.includes(`kitRoot: ${JSON.stringify(stable.path)}`), "only the kitRoot line changes");
  assert.ok(rewritten.endsWith("# Dev\n"));

  // An update installs a new folder and removes the old one.
  const second = install("second");
  rmSync(join(installs, "first"), { recursive: true, force: true });
  report = await service.read();
  assert.equal(samePath(readlinkSync(report.kit.stable.path), second, "win32"), true, "the link follows the update");
  assert.equal(report.kit.profiles.find(entry => entry.file === profile).status, "installed", "the profile keeps working");
  assert.deepEqual(report.kit.stable.profilesToMove, []);
  assert.match((await service.plan({ kind: "kit-root" })).blocked, /already uses the stable kit path/);
});

test("a folder that isn't Mission Control's link at the stable kit path is left alone", async t => {
  const { service, root } = fixture(t);
  write(join(root, "paseo", "plugins", "mission-control", "only", "checkout", "scripts", "dev-flow.mjs"));
  mkdirSync(join(root, "paseo", "plugins", "mission-control", "only", "checkout", "skills"), { recursive: true });
  write(join(root, "paseo", "plugin-data", "mission-control", "kit", "notes.txt"), "mine");
  const report = await service.read();
  assert.equal(report.kit.stable.status, "modified");
  assert.equal(readFileSync(join(root, "paseo", "plugin-data", "mission-control", "kit", "notes.txt"), "utf8"), "mine");
});

// ---------- skill links ----------

test("skill links: junctions are created after a plan, recorded, and then read as installed", async t => {
  const { home, kit, service } = fixture(t);
  const action = { kind: "skills", provider: "claude", group: "development-flow" };
  const plan = await service.plan(action);
  assert.equal(plan.blocked, null);
  assert.deepEqual(plan.changes.map(change => [change.change, change.path]), [
    ["create-link", join(home, ".claude", "skills", "plan-task")],
    ["create-link", join(home, ".claude", "skills", "write-handoff")],
  ]);
  assert.match(plan.changes[0].detail, /Junction → .*plan-task/);

  const result = await service.apply(action, plan.fingerprint);
  assert.equal(result.ok, true, result.changes.join("\n"));
  const link = join(home, ".claude", "skills", "plan-task");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.ok(samePath(readlinkSync(link), join(kit, "skills", "plan-task"), "win32"));
  const marker = JSON.parse(readFileSync(join(home, ".claude", "skills", MARKER), "utf8"));
  assert.equal(marker.managedBy, "mission-control");
  assert.deepEqual(Object.keys(marker.links).sort(), ["plan-task", "write-handoff"]);

  const report = await service.read();
  assert.equal(group(report, "claude").status, "installed");
  assert.equal(group(report, "claude").blocked, "Nothing to install.");
  assert.equal(report.log[0].action, "Link Development Flow skills for Claude Code");
  assert.equal(report.log[0].ok, true);

  const delegate = { kind: "skills", provider: "claude", group: "ocr-delegate" };
  const delegatePlan = await service.plan(delegate);
  assert.equal((await service.apply(delegate, delegatePlan.fingerprint)).ok, true);
  const both = JSON.parse(readFileSync(join(home, ".claude", "skills", MARKER), "utf8"));
  assert.deepEqual(Object.keys(both.links).sort(), ["open-code-review-delegate", "plan-task", "write-handoff"], "the record keeps earlier links");
});

test("skill links: a folder Mission Control didn't create is Not managed and never replaced", async t => {
  const { home, kit, service } = fixture(t);
  const skills = join(home, ".codex", "skills");
  write(join(skills, "write-handoff", "SKILL.md"), "the user's own skill");
  symlinkSync(join(kit, "skills", "plan-task"), join(skills, "plan-task"), "junction");
  const report = await service.read();
  const codex = group(report, "codex");
  assert.deepEqual(codex.links.map(link => link.status), ["installed", "not-managed"]);
  assert.match(codex.links[0].note, /Linked outside Mission Control/);
  assert.match(codex.links[1].note, /didn't create; left alone/);
  assert.equal(codex.status, "not-managed");

  const action = { kind: "skills", provider: "codex", group: "development-flow" };
  const plan = await service.plan(action);
  assert.deepEqual(plan.changes.map(change => change.change), ["skip", "skip"]);
  assert.equal(plan.blocked, "Nothing to install.");
  await assert.rejects(service.apply(action, plan.fingerprint), /Nothing to install/);
  assert.equal(readFileSync(join(skills, "write-handoff", "SKILL.md"), "utf8"), "the user's own skill");
  assert.ok(!existsSync(join(skills, MARKER)));
});

test("skill links: a link to somewhere else is Not managed; Mission Control's own old link is Outdated and re-pointed", async t => {
  const { home, kit, root, service } = fixture(t);
  const skills = join(home, ".copilot", "skills");
  const oldKit = join(root, "old-kit");
  write(join(oldKit, "skills", "plan-task", "SKILL.md"), "old");
  write(join(root, "elsewhere", "SKILL.md"), "someone else's");
  symlinkSync(join(oldKit, "skills", "plan-task"), join(skills, "plan-task"), "junction");
  symlinkSync(join(root, "elsewhere"), join(skills, "write-handoff"), "junction");
  write(join(skills, MARKER), JSON.stringify({ links: { "plan-task": { target: join(oldKit, "skills", "plan-task"), linkedAt: "2026-09-01T00:00:00Z" } } }));

  const copilot = group(await service.read(), "copilot");
  assert.deepEqual(copilot.links.map(link => link.status), ["outdated", "not-managed"]);
  const action = { kind: "skills", provider: "copilot", group: "development-flow" };
  const plan = await service.plan(action);
  assert.deepEqual(plan.changes.map(change => change.change), ["replace-link", "skip"]);
  const result = await service.apply(action, plan.fingerprint);
  assert.equal(result.ok, true);
  assert.ok(samePath(readlinkSync(join(skills, "plan-task")), join(kit, "skills", "plan-task"), "win32"));
  assert.equal(readFileSync(join(oldKit, "skills", "plan-task", "SKILL.md"), "utf8"), "old", "removing a junction leaves its target alone");
  assert.ok(samePath(readlinkSync(join(skills, "write-handoff")), join(root, "elsewhere"), "win32"));
});

test("skill links: a recorded link that now points somewhere else is Modified and left alone", async t => {
  const { home, kit, root, service } = fixture(t);
  const skills = join(home, ".claude", "skills");
  write(join(root, "elsewhere", "SKILL.md"), "re-pointed by the user");
  symlinkSync(join(root, "elsewhere"), join(skills, "plan-task"), "junction");
  write(join(skills, MARKER), JSON.stringify({ links: { "plan-task": { target: join(kit, "skills", "plan-task-old"), linkedAt: "" } } }));
  const link = group(await service.read(), "claude").links[0];
  assert.equal(link.status, "modified");
  assert.match(link.note, /Mission Control linked this to .*plan-task-old, but it now points at .*elsewhere; left alone/);
  const plan = await service.plan({ kind: "skills", provider: "claude", group: "development-flow" });
  assert.deepEqual(plan.changes.map(change => change.change), ["skip", "create-link"]);
  await service.apply({ kind: "skills", provider: "claude", group: "development-flow" }, plan.fingerprint);
  assert.ok(samePath(readlinkSync(join(skills, "plan-task")), join(root, "elsewhere"), "win32"));
});

test("skill links: a recorded link replaced by a folder is Modified and left alone", async t => {
  const { home, kit, service } = fixture(t);
  const skills = join(home, ".claude", "skills");
  write(join(skills, "plan-task", "SKILL.md"), "edited copy");
  write(join(skills, MARKER), JSON.stringify({ links: { "plan-task": { target: join(kit, "skills", "plan-task"), linkedAt: "" } } }));
  const claude = group(await service.read(), "claude");
  assert.equal(claude.links[0].status, "modified");
  const plan = await service.plan({ kind: "skills", provider: "claude", group: "development-flow" });
  assert.deepEqual(plan.changes.map(change => change.change), ["skip", "create-link"]);
  await service.apply({ kind: "skills", provider: "claude", group: "development-flow" }, plan.fingerprint);
  assert.equal(readFileSync(join(skills, "plan-task", "SKILL.md"), "utf8"), "edited copy");
  assert.ok(lstatSync(join(skills, "write-handoff")).isSymbolicLink());
});

test("skill links: apply refuses a plan that no longer matches, and a missing provider folder", async t => {
  const { home, service } = fixture(t);
  const action = { kind: "skills", provider: "claude", group: "development-flow" };
  const plan = await service.plan(action);
  write(join(home, ".claude", "skills", "plan-task", "SKILL.md"), "appeared after the check");
  await assert.rejects(service.apply(action, plan.fingerprint), /changed since you reviewed/);
  assert.equal(readFileSync(join(home, ".claude", "skills", "plan-task", "SKILL.md"), "utf8"), "appeared after the check");
  assert.ok(!existsSync(join(home, ".claude", "skills", "write-handoff")));

  const opencode = await service.plan({ kind: "skills", provider: "opencode", group: "development-flow" });
  assert.match(opencode.blocked, /doesn't exist/);
  await assert.rejects(service.apply({ kind: "skills", provider: "opencode", group: "development-flow" }, opencode.fingerprint), /doesn't exist/);
  assert.ok(!existsSync(join(home, ".config", "opencode")), "the provider's folder isn't created");
  const unknown = await service.plan({ kind: "skills", provider: "nope", group: "development-flow" });
  assert.match(unknown.blocked, /isn't in Mission Control's manifest/);
});

// ---------- OCR rule files ----------

test("OCR rule files: missing files are copied from the kit and recorded by hash", async t => {
  const { home, kit, service } = fixture(t);
  const plan = await service.plan({ kind: "ocr-rules" });
  assert.deepEqual(plan.changes.map(change => change.change), ["write-file", "write-file", "write-file", "write-file"]);
  assert.deepEqual(plan.changes.map(change => change.path), setupManifest.ocr.files.map(file => join(home, ".opencodereview", ...file.path.split("/"))));
  const result = await service.apply({ kind: "ocr-rules" }, plan.fingerprint);
  assert.equal(result.ok, true, result.changes.join("\n"));
  for (const file of setupManifest.ocr.files) {
    assert.equal(readFileSync(join(home, ".opencodereview", file.path), "utf8"), readFileSync(join(kit, file.source), "utf8"));
  }
  const marker = JSON.parse(readFileSync(join(home, ".opencodereview", MARKER), "utf8"));
  assert.match(marker.files["rule.json"].sha256, /^[a-f0-9]{64}$/);
  const report = await service.read();
  assert.ok(report.ocrRules.files.every(file => file.status === "installed"));
  assert.equal(byId(report.tools, "ocr-rules").status, "installed");
});

test("OCR rule files: an edited file is Modified and left alone; an unchanged one is updated when the kit changes", async t => {
  const { home, kit, service } = fixture(t);
  const first = await service.plan({ kind: "ocr-rules" });
  await service.apply({ kind: "ocr-rules" }, first.fingerprint);
  const ocrHome = join(home, ".opencodereview");
  writeFileSync(join(ocrHome, "reviewer-prompt.md"), "my own prompt\n");
  writeFileSync(join(kit, "docs", "ocr-kit", "csharp-dotnet.md"), "newer kit rule\n");
  writeFileSync(join(kit, "docs", "ocr-kit", "reviewer-prompt.md"), "newer kit prompt\n");

  const report = await service.read();
  const status = Object.fromEntries(report.ocrRules.files.map(file => [file.path, file.status]));
  assert.deepEqual(status, { "rule.json": "installed", "rules/csharp-dotnet.md": "outdated", "reviewer-prompt.md": "modified", "review-output.schema.json": "installed" });
  assert.equal(byId(report.tools, "ocr-rules").status, "outdated");

  const plan = await service.plan({ kind: "ocr-rules" });
  assert.deepEqual(plan.changes.map(change => change.change), ["skip", "update-file", "skip", "skip"]);
  assert.equal((await service.apply({ kind: "ocr-rules" }, plan.fingerprint)).ok, true);
  assert.equal(readFileSync(join(ocrHome, "rules", "csharp-dotnet.md"), "utf8"), "newer kit rule\n");
  assert.equal(readFileSync(join(ocrHome, "reviewer-prompt.md"), "utf8"), "my own prompt\n");
});

test("OCR rule files: an existing rule.json is never merged or overwritten", async t => {
  const { home, service } = fixture(t);
  const ruleJson = join(home, ".opencodereview", "rule.json");
  write(ruleJson, '{ "rules": [] }\n');
  const report = await service.read();
  const rule = report.ocrRules.files.find(file => file.path === "rule.json");
  assert.equal(rule.status, "not-managed");
  assert.match(rule.note, /never merged automatically/);
  const plan = await service.plan({ kind: "ocr-rules" });
  assert.equal(plan.changes[0].change, "skip");
  await service.apply({ kind: "ocr-rules" }, plan.fingerprint);
  assert.equal(readFileSync(ruleJson, "utf8"), '{ "rules": [] }\n');
  assert.equal(JSON.parse(readFileSync(join(home, ".opencodereview", MARKER), "utf8")).files["rule.json"], undefined);
});

test("OCR rule files: a file edited between the check and the write is left alone", async t => {
  const { home, service } = fixture(t);
  const plan = await service.plan({ kind: "ocr-rules" });
  write(join(home, ".opencodereview", "reviewer-prompt.md"), "written in between\n");
  await assert.rejects(service.apply({ kind: "ocr-rules" }, plan.fingerprint), /changed since you reviewed/);
  assert.equal(readFileSync(join(home, ".opencodereview", "reviewer-prompt.md"), "utf8"), "written in between\n");
  assert.ok(!existsSync(join(home, ".opencodereview", "rule.json")));
});

// ---------- OCR CLI ----------

test("OCR CLI: installs the pinned version through npm's JavaScript entry point, then logs scrubbed output", async t => {
  const { bin, globals, host, service, calls } = fixture(t);
  host.install = async () => {
    write(join(globals, "@alibaba-group", "open-code-review", "package.json"), JSON.stringify({ version: "1.12.9" }));
    return { code: 0, stdout: "changed 1 package in 3s\n//registry.npmjs.org/:_authToken=npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789\n", stderr: "" };
  };
  const plan = await service.plan({ kind: "ocr-cli" });
  assert.equal(plan.blocked, null);
  assert.equal(plan.command, "npm install -g @alibaba-group/open-code-review@1.12.9");
  assert.equal(plan.title, "Change OCR 1.12.8 to 1.12.9");
  const result = await service.apply({ kind: "ocr-cli" }, plan.fingerprint);
  assert.equal(result.ok, true);
  const install = calls.find(call => call.args.includes("install"));
  assert.equal(install.file, join(bin, "node.exe"));
  assert.deepEqual(install.args, [join(bin, "node_modules", "npm", "bin", "npm-cli.js"), "install", "-g", "@alibaba-group/open-code-review@1.12.9"]);
  assert.equal(install.options.timeoutMs, 300_000);
  assert.doesNotMatch(result.output, /npm_AbCd/);
  const log = readFileSync(join(host.dataDir, "setup-log.jsonl"), "utf8");
  assert.doesNotMatch(log, /npm_AbCd/);
  assert.match(log, /Installed OCR 1\.12\.9/);

  const again = await service.plan({ kind: "ocr-cli" });
  assert.match(again.blocked, /already installed/);
  assert.equal(byId((await service.read()).tools, "ocr").status, "installed");
});

test("OCR CLI: a slow install replies 'still running', and read() reports it until its result arrives", async t => {
  const { globals, host, service } = fixture(t, { replyWithinMs: 50 });
  let release;
  host.install = () => new Promise(resolvePromise => {
    release = () => {
      write(join(globals, "@alibaba-group", "open-code-review", "package.json"), JSON.stringify({ version: "1.12.9" }));
      resolvePromise({ code: 0, stdout: "changed 1 package\n", stderr: "" });
    };
  });
  const plan = await service.plan({ kind: "ocr-cli" });
  const reply = await service.apply({ kind: "ocr-cli" }, plan.fingerprint);
  assert.equal(reply.running, true);
  assert.match(reply.summary, /still running/);
  assert.doesNotMatch(reply.summary, /Nothing was installed|failed/);

  const during = await service.read();
  assert.deepEqual(during.running, { action: { kind: "ocr-cli" }, title: "Change OCR 1.12.8 to 1.12.9", startedAt: reply.startedAt });
  assert.equal(during.lastResult, null);
  const rules = await service.plan({ kind: "ocr-rules" });
  await assert.rejects(service.apply({ kind: "ocr-rules" }, rules.fingerprint), /Another install is running/);

  release();
  let after = await service.read();
  for (let attempt = 0; after.running && attempt < 100; attempt++) { await new Promise(done => setTimeout(done, 20)); after = await service.read(); }
  assert.equal(after.running, null);
  assert.equal(after.lastResult.startedAt, reply.startedAt, "the screen matches the result to the install it followed");
  assert.equal(after.lastResult.ok, true);
  assert.equal(after.lastResult.summary, "Installed OCR 1.12.9.");
  assert.equal(after.log[0].summary, "Installed OCR 1.12.9.");
  assert.equal(byId(after.tools, "ocr").status, "installed");
});

test("an install that finishes inside the reply window replies with its result, and a failed log write doesn't hide it", async t => {
  const { home, host, service } = fixture(t);
  write(host.dataDir, "a file where the log folder should be");
  const plan = await service.plan({ kind: "ocr-rules" });
  const result = await service.apply({ kind: "ocr-rules" }, plan.fingerprint);
  assert.equal(result.running, false);
  assert.equal(result.ok, true);
  assert.match(result.changes.at(-1), /install log couldn't be written/);
  assert.ok(existsSync(join(home, ".opencodereview", "rule.json")), "the changes stand");
  assert.equal((await service.read()).lastResult.startedAt, result.startedAt);
});

test("OCR CLI: a failed npm run is reported and logged, not claimed as installed", async t => {
  const { host, service } = fixture(t, { ocrVersion: null });
  host.install = async () => ({ code: 1, stdout: "", stderr: "npm error code E404\n" });
  const plan = await service.plan({ kind: "ocr-cli" });
  assert.equal(plan.title, "Install OCR 1.12.9");
  const result = await service.apply({ kind: "ocr-cli" }, plan.fingerprint);
  assert.equal(result.ok, false);
  assert.match(result.changes[0], /exit code 1/);
  assert.match(result.output, /E404/);
  const log = (await service.read()).log;
  assert.equal(log[0].ok, false);
});

test("OCR CLI: without npm beside Node, nothing runs", async t => {
  const { bin, service, calls } = fixture(t);
  rmSync(join(bin, "node_modules"), { recursive: true });
  const plan = await service.plan({ kind: "ocr-cli" });
  assert.match(plan.blocked, /npm wasn't found/);
  await assert.rejects(service.apply({ kind: "ocr-cli" }, plan.fingerprint), /npm wasn't found/);
  assert.ok(!calls.some(call => call.args.includes("install")));
});

test("one install runs at a time, and the log keeps the last 100 entries", async t => {
  const { host, service } = fixture(t);
  let release;
  host.install = () => new Promise(resolvePromise => { release = () => resolvePromise({ code: 1, stdout: "", stderr: "" }); });
  const plan = await service.plan({ kind: "ocr-cli" });
  const first = service.apply({ kind: "ocr-cli" }, plan.fingerprint);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  const rules = await service.plan({ kind: "ocr-rules" });
  await assert.rejects(service.apply({ kind: "ocr-rules" }, rules.fingerprint), /Another install is running/);
  release();
  await first;

  write(join(host.dataDir, "setup-log.jsonl"), Array.from({ length: 100 }, (_, index) => JSON.stringify({ at: `old-${index}`, action: "x", summary: "x", ok: true, changes: [], output: null })).join("\n") + "\n");
  const fresh = await service.plan({ kind: "ocr-rules" });
  await service.apply({ kind: "ocr-rules" }, fresh.fingerprint);
  const lines = readFileSync(join(host.dataDir, "setup-log.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 100);
  assert.equal(JSON.parse(lines[0]).at, "old-1");
  assert.equal((await service.read()).log.length, 10);

  write(join(host.dataDir, "setup-log.jsonl"), `{"torn\n{"at": 1}\n${lines.at(-1)}\n`);
  assert.equal((await service.read()).log.length, 1, "torn or foreign lines don't break the screen");
});

// ---------- the manifest ----------

test("the manifest lists every dependency from the report, and only three kinds are installable", () => {
  const ids = setupManifest.dependencies.map(entry => entry.id);
  for (const id of ["paseo", "node", "npm", "git", "gh", "az", "bitbucket", "gortex", "ocr", "ocr-rules", "obsidian", "obsidian-cli", "claude", "codex", "opencode", "copilot"]) assert.ok(ids.includes(id), id);
  assert.deepEqual(setupManifest.dependencies.filter(entry => entry.install === "mission-control").map(entry => entry.id), ["ocr", "ocr-rules"]);
  assert.equal(setupManifest.dependencies.find(entry => entry.id === "ocr").pinned, setupManifest.ocr.version);
  assert.deepEqual(setupManifest.skills.providers.map(entry => entry.id), ["claude", "codex", "opencode", "copilot"]);
  for (const file of setupManifest.ocr.files) assert.ok(existsSync(join(REPO, file.source)), file.source);
  assert.ok(existsSync(join(REPO, setupManifest.skills.delegate.source, "SKILL.md")));
});

// ---------- pull request tools (task 21) ----------

test("gh, az and Bitbucket credentials show their sign-in state, and a credential never reaches the report", async t => {
  const secret = "app-password-Zx9QmL2vR7tK4pW8";
  const { host, bin, root, service, calls } = fixture(t);
  write(join(bin, "gh.exe"));
  const cli2 = join(root, "Azure", "CLI2");
  write(join(cli2, "wbin", "az.cmd"), "@echo off\n");
  write(join(cli2, "python.exe"));
  host.env.PATH = `${bin};${join(cli2, "wbin")}`;
  const answer = (file, args) => {
    const name = file.split(/[\\/]/).pop();
    if (name === "gh.exe") return args[0] === "--version" ? { code: 0, stdout: "gh version 2.61.0 (2024-11-06)\n" } : { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account octo (keyring)\n  - Token: gho_************************************\n" };
    if (name === "python.exe") {
      assert.deepEqual(args.slice(0, 2), ["-IBm", "azure.cli"], "az runs as python -IBm azure.cli, not through az.cmd");
      if (args[2] === "version") return { code: 0, stdout: JSON.stringify({ "azure-cli": "2.67.0" }) };
      if (args[2] === "extension") return { code: 0, stdout: JSON.stringify({ name: "azure-devops", version: "1.0.1" }) };
      if (args[2] === "account") return { code: 1, stdout: "", stderr: "Please run 'az login' to setup account." };
      // az devops login's token works for the Server, not for the cloud organization.
      if (args[2] === "devops") return args.includes("http://tfs.corp:8080/tfs/DefaultCollection") ? { code: 0, stdout: "[]" } : { code: 1, stdout: "", stderr: "TF400813: not authorized" };
    }
    if (name === "git.exe" && args.includes("credential")) return { code: 0, stdout: `protocol=https\nhost=bitbucket.org\nusername=someone\npassword=${secret}\n` };
    return { code: 0, stdout: "git version 2.35.3.windows.1\n" };
  };
  host.run = async (file, args, options) => { calls.push({ file, args, options }); return { stderr: "", ...answer(file, args) }; };
  const report = await service.read();
  const gh = byId(report.tools, "gh");
  assert.equal(gh.status, "installed");
  assert.equal(gh.version, "2.61.0");
  assert.deepEqual(gh.signIn, { signedIn: true, detail: "Signed in to github.com as octo." });
  const az = byId(report.tools, "az");
  assert.equal(az.version, "2.67.0");
  assert.equal(az.detail, join(cli2, "python.exe"));
  assert.deepEqual(az.signIn, { signedIn: false, detail: "azure-devops 1.0.1; not signed in. Run: az login (Azure DevOps Services), or az devops login --organization <URL> (Azure DevOps Server)" });
  // With the organizations the projects use, each is asked with a real az devops call (az devops login counts).
  const withOrganizations = byId((await service.read(undefined, async () => ({ forges: new Set(["azure-devops"]), githubHosts: [], azureOrganizations: ["http://tfs.corp:8080/tfs/DefaultCollection", "https://dev.azure.com/contoso"] }))).tools, "az");
  assert.equal(withOrganizations.signIn.signedIn, false);
  assert.match(withOrganizations.signIn.detail, /signed in to http:\/\/tfs\.corp:8080\/tfs\/DefaultCollection; not signed in to https:\/\/dev\.azure\.com\/contoso\. Run: az login, or az devops login --organization https:\/\/dev\.azure\.com\/contoso\./);
  const bitbucket = byId(report.tools, "bitbucket");
  assert.equal(bitbucket.status, "installed");
  assert.match(bitbucket.detail, /Found in Git's credential store/);
  // The credential request can't prompt or open a window, and nothing of the answer is kept.
  const fill = calls.find(call => call.args.includes("credential"));
  assert.equal(fill.options.input, "protocol=https\nhost=bitbucket.org\n\n");
  assert.equal(fill.options.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(fill.options.env.GCM_INTERACTIVE, "never");
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(JSON.stringify(report).includes("someone"), false);

  // An environment token counts too; without any credential the row says what to set.
  host.env.BITBUCKET_TOKEN = "bb-token";
  assert.match(byId((await service.read()).tools, "bitbucket").detail, /Found in the BITBUCKET_TOKEN environment variable/);
  delete host.env.BITBUCKET_TOKEN;
  host.run = async (file, args) => file.endsWith("git.exe") && args.includes("credential") ? { code: 128, stdout: "", stderr: "fatal: could not read Username" } : { stderr: "", ...answer(file, args) };
  const none = byId((await service.read()).tools, "bitbucket");
  assert.equal(none.status, "missing");
  assert.match(none.detail, /No BITBUCKET_TOKEN/);
});

test("gh and az that aren't installed are Missing, with no sign-in line", async t => {
  const { service } = fixture(t);
  const report = await service.read();
  for (const id of ["gh", "az"]) {
    assert.equal(byId(report.tools, id).status, "missing", id);
    assert.equal(byId(report.tools, id).signIn ?? null, null, id);
  }
});

test("Setup shows the forge tools only for forges this host's projects use, and checks gh on their GitHub hosts", async t => {
  const { host, bin, service, calls } = fixture(t);
  write(join(bin, "gh.exe"));
  host.run = async (file, args, options) => {
    calls.push({ file, args, options });
    const name = file.split(/[\\/]/).pop();
    if (name === "gh.exe") return { code: 0, stdout: args[0] === "--version" ? "gh version 2.61.0\n" : `Logged in to ${args[3]} account octo\n`, stderr: "" };
    return { code: 0, stdout: "git version 2.35.3.windows.1\n", stderr: "" };
  };
  const onlyGithub = await service.read(undefined, async () => ({ forges: new Set(["github"]), githubHosts: ["github.com", "github.example.com"] }));
  const ids = onlyGithub.tools.map(item => item.id);
  assert.ok(ids.includes("gh"));
  assert.ok(!ids.includes("az") && !ids.includes("bitbucket"), ids.join(", "));
  assert.deepEqual(onlyGithub.hiddenTools.map(tool => [tool.id, tool.reason]), [
    ["az", "No project on this host uses Azure DevOps."], ["bitbucket", "No project on this host uses Bitbucket Cloud."],
  ]);
  assert.deepEqual(byId(onlyGithub.tools, "gh").signIn, { signedIn: true, detail: "Signed in to github.com as octo. Signed in to github.example.com as octo." });
  assert.ok(calls.some(call => call.args.join(" ") === "auth status --hostname github.example.com"));
  // No forge in use hides all three; unreadable projects show all three.
  assert.deepEqual((await service.read(undefined, async () => ({ forges: new Set(), githubHosts: [] }))).hiddenTools.map(tool => tool.id), ["gh", "az", "bitbucket"]);
  const unknown = await service.read(undefined, async () => null);
  assert.deepEqual(unknown.hiddenTools, []);
  assert.ok(["gh", "az", "bitbucket"].every(id => unknown.tools.some(item => item.id === id)));
});
