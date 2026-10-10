import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { createPluginUpdater, displayRemote, readApplyFailure, readSource, redactUrls } = require("./plugin-updates.ts");
const { missionControlVersion } = require("../shared/version.ts");

const checkedAt = "2026-09-26T12:00:00.000Z";
const newer = "bbbbbbb2222222222222222222222222222222222";
const gitIdentity = { kind: "git", remote: "https://github.com/owner/development-flow.git", pluginPath: "plugins/mission-control" };
const available = [{
  id: "mission-control", outcome: "update",
  current: { identity: gitIdentity, currentRevision: "aaaaaaa1111111111111111111111111111111111" },
  target: { kind: "git", commit: newer },
  links: ["https://github.com/owner/development-flow/compare/a...b", "javascript:alert(1)"],
}];
const upToDate = [{ id: "mission-control", outcome: "current", current: { identity: gitIdentity, currentRevision: "c" }, links: [] }];

// `preview` is the CLI's stdout; `code` its exit code (Paseo exits 1 when an outcome is `error`). `runError` means it could not run.
function fixture(preview, { code = 0, runError, startError } = {}) {
  const runs = [], starts = [], exits = [];
  const state = { preview, code };
  const updater = createPluginUpdater({
    run: async args => { runs.push(args); if (runError) throw runError; return { code: state.code, output: typeof state.preview === "string" ? state.preview : JSON.stringify(state.preview) }; },
    start: async (args, onExit) => { starts.push(args); if (startError) throw startError; exits.push(onExit); },
    now: () => new Date(checkedAt),
  });
  return { updater, runs, starts, exits, state };
}

test("the built-in version matches package.json", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(missionControlVersion, manifest.version);
  assert.match(missionControlVersion, /^\d+\.\d+\.\d+$/);
  assert.notEqual(missionControlVersion, "0.0.0");
});

test("an available Git update reports the version, source, both revisions and only https links", async () => {
  const f = fixture(available);
  const status = await f.updater.check();
  assert.deepEqual(f.runs, [["plugin", "update", "mission-control", "--check", "--json"]]);
  assert.deepEqual(status, {
    version: missionControlVersion, state: "update", checkedAt, error: null, updating: false, lastUpdateError: null,
    source: { kind: "git", remote: "https://github.com/owner/development-flow.git", pluginPath: "plugins/mission-control" },
    current: "aaaaaaa1111111111111111111111111111111111", target: newer,
    links: ["https://github.com/owner/development-flow/compare/a...b"],
  });
});

test("the folder install on this host reports its path and the local state", async () => {
  // Real output of `paseo plugin update mission-control --check --json` on personal, 26 Sep 2026.
  const output = JSON.stringify([{ id: "mission-control", outcome: "local", current: { identity: { kind: "directory", path: "C:\\Code\\development-flow\\plugins\\mission-control" } }, links: [] }], null, 2);
  const status = await fixture(output).updater.check();
  assert.equal(status.state, "local");
  assert.equal(status.error, null);
  assert.equal(status.current, null);
  assert.equal(status.target, null);
  assert.deepEqual(status.source, { kind: "directory", path: "C:\\Code\\development-flow\\plugins\\mission-control" });
});

test("up-to-date and newer installs are read, including output prefixed with text", async () => {
  const current = await fixture(`mission-control: up to date\n${JSON.stringify([{ id: "mission-control", outcome: "current", current: { identity: gitIdentity, currentRevision: "ccc" }, target: { kind: "git", commit: "ccc" }, links: [] }])}`).updater.check();
  assert.equal(current.state, "current"); assert.equal(current.current, "ccc"); assert.equal(current.target, "ccc");
  const ahead = await fixture([{ id: "mission-control", outcome: "installed-newer", current: { identity: { kind: "npm", packageName: "mission-control" }, currentRevision: "2.0.0" }, target: { kind: "npm", version: "1.0.0" }, links: [] }]).updater.check();
  assert.equal(ahead.state, "installed-newer"); assert.equal(ahead.error, null); assert.equal(ahead.target, "1.0.0");
});

test("a failed check shows Paseo's own reason and the source, even though the CLI exits 1", async () => {
  // Paseo prints the list and exits 1 when an outcome is `error`.
  const output = JSON.stringify([{ id: "mission-control", outcome: "error", error: "git ls-remote https://nick:ghp_secret@github.com/owner/development-flow.git failed: Authentication failed", current: { identity: gitIdentity, currentRevision: "a" }, links: [] }]);
  const status = await fixture(output, { code: 1 }).updater.check();
  assert.equal(status.state, "error");
  assert.equal(status.error, "git ls-remote https://github.com/owner/development-flow.git failed: Authentication failed");
  assert.deepEqual(status.source, { kind: "git", remote: "https://github.com/owner/development-flow.git", pluginPath: "plugins/mission-control" });
  assert.equal(status.current, "a");
  const unreadable = await fixture("Error: daemon not reachable", { code: 1 }).updater.check();
  assert.equal(unreadable.state, "error"); assert.equal(unreadable.error, "Paseo's update check failed (exit code 1).");
});

// Paseo's shape when a command fails outright (seen live, live-check-3.txt); `details` is a stack trace with local paths.
const thrownError = (message) => `${JSON.stringify({ error: { code: "UNKNOWN_ERROR", message, details: `Error: ${message}\n    at reviewPluginUpdates (file:///C:/Users/me/AppData/Local/Programs/Paseo/resources/app.asar/update.js:3:15)` } }, null, 2)}\n`;

test("a check that fails outright shows Paseo's message from stderr, never its stack trace", async () => {
  const f = createPluginUpdater({ run: async () => ({ code: 1, output: "", errors: thrownError("connect https://u:p@daemon failed") }), now: () => new Date(checkedAt) });
  const status = await f.check();
  assert.equal(status.state, "error");
  assert.equal(status.error, "Paseo's update check failed: connect https://daemon failed");
  assert.doesNotMatch(status.error, /app\.asar|reviewPluginUpdates/);
});

test("a missing CLI, unreadable output, a missing entry and unknown outcomes are errors, never up to date", async () => {
  const missing = await fixture([], { runError: new Error("The Paseo CLI (paseo.cmd) was not found on this host.") }).updater.check();
  assert.equal(missing.state, "unavailable"); assert.match(missing.error, /not found/); assert.equal(missing.version, missionControlVersion);
  assert.equal((await fixture("not json").updater.check()).state, "error");
  const other = await fixture([{ id: "review-deck", outcome: "current" }]).updater.check();
  assert.equal(other.state, "error"); assert.match(other.error, /did not report Mission Control/);
  const unknown = await fixture([{ id: "mission-control", outcome: "surprise", links: [] }]).updater.check();
  assert.equal(unknown.state, "error"); assert.match(unknown.error, /Unknown update outcome: surprise/);
});

test("sources and messages never show credentials, and npm installs show their package name", () => {
  assert.equal(displayRemote("https://user:secret@github.com/owner/repo.git"), "https://github.com/owner/repo.git");
  assert.equal(displayRemote("https://token@github.com/owner/repo.git"), "https://github.com/owner/repo.git");
  assert.equal(displayRemote("git@github.com:owner/repo.git"), "git@github.com:owner/repo.git");
  assert.equal(redactUrls("fetch https://a:b@host/x and ssh://git@host/y failed"), "fetch https://host/x and ssh://host/y failed");
  assert.deepEqual(readSource({ kind: "git", remote: "https://x:y@github.com/o/r.git", pluginPath: "." }), { kind: "git", remote: "https://github.com/o/r.git", pluginPath: null });
  // Paseo's npm identity field is `packageName`.
  assert.deepEqual(readSource({ kind: "npm", packageName: "mission-control" }), { kind: "npm", name: "mission-control" });
  assert.deepEqual(readSource({ kind: "catalog" }), { kind: "other", label: "catalog" });
  assert.equal(readSource(null), null);
  assert.equal(readSource({ kind: "directory" }), null);
});

test("apply rechecks, requires the reviewed target, and starts the update once", async () => {
  const f = fixture(available);
  await assert.rejects(f.updater.apply("someothercommit"), /different update appeared/);
  assert.equal(f.starts.length, 0);
  assert.deepEqual(await f.updater.apply(newer), { started: true });
  assert.deepEqual(f.starts, [["plugin", "update", "mission-control", "--yes", "--json"]]);
  await assert.rejects(f.updater.apply(newer), /already running/);
  assert.equal(f.starts.length, 1);
});

test("while Paseo applies the update, checks report it without running the CLI again", async () => {
  const f = fixture(available);
  await f.updater.apply(newer);
  const runs = f.runs.length;
  const status = await f.updater.check();
  assert.equal(status.updating, true); assert.equal(status.state, "update"); assert.equal(status.target, newer);
  assert.equal(f.runs.length, runs);
});

test("an update that fails before Paseo replaces the plugin reports why and allows a retry", async () => {
  const f = fixture(available);
  await f.updater.apply(newer);
  // `--yes --json` prints the same list; a failed apply has outcome `error`, and the CLI exits 1.
  f.exits[0]({ code: 1, output: JSON.stringify([{ id: "mission-control", outcome: "error", error: "Could not resolve type dependency @getpaseo/client", links: [] }]) });
  const status = await f.updater.check();
  assert.equal(status.updating, false);
  assert.equal(status.state, "update");
  assert.equal(status.lastUpdateError, "Could not resolve type dependency @getpaseo/client");
  assert.deepEqual(await f.updater.apply(newer), { started: true }, "a failed update must not block a retry");
  assert.equal(f.starts.length, 2);
  assert.equal((await f.updater.check()).lastUpdateError, null, "a new attempt clears the previous failure while it runs");
});

test("apply failures are read from the CLI's list, its last line, or its exit code", () => {
  assert.equal(readApplyFailure({ code: 1, output: JSON.stringify([{ id: "mission-control", outcome: "error", error: "Git target changed since review" }]) }), "Git target changed since review");
  assert.equal(readApplyFailure({ code: 1, output: "Starting…\nError: connect https://u:p@host failed\n" }), "Error: connect https://host failed");
  assert.equal(readApplyFailure({ code: 3, output: "" }), "Paseo's update exited with code 3.");
  // Seen live: a list without Mission Control must not show its closing bracket.
  assert.equal(readApplyFailure({ code: 1, output: JSON.stringify([{ id: "other", outcome: "error", error: "x" }], null, 2) }), "Paseo's update exited with code 1.");
  // A thrown error (for example Paseo's 300-second apply timeout) is read from its object, not shown as "}".
  assert.equal(readApplyFailure({ code: 1, output: thrownError("Timed out waiting for applyPluginUpdates") }), "Timed out waiting for applyPluginUpdates");
  assert.equal(readApplyFailure({ code: 1, output: "{\n  \"error\": \"cut off" }), "Paseo's update exited with code 1.");
  assert.equal(readApplyFailure({ code: 0, output: JSON.stringify([{ id: "mission-control", outcome: "current" }]) }), null);
});

test("an update that ends without a reported failure but without a reload still frees the retry", async () => {
  const f = fixture(available);
  await f.updater.apply(newer);
  f.exits[0]({ code: 0, output: JSON.stringify(upToDate) });
  f.state.preview = upToDate;
  const status = await f.updater.check();
  assert.equal(status.updating, false); assert.equal(status.state, "current");
  assert.match(status.lastUpdateError, /without reloading/);
});

test("nothing starts without an update, and a failed start can be retried", async () => {
  const current = fixture(upToDate);
  await assert.rejects(current.updater.apply("c"), /already up to date/);
  const local = fixture([{ id: "mission-control", outcome: "local", current: { identity: { kind: "directory", path: "C:\\x" } }, links: [] }]);
  await assert.rejects(local.updater.apply("x"), /No update is available \(local\)/);
  const unavailable = fixture([], { runError: new Error("no CLI") });
  await assert.rejects(unavailable.updater.apply("x"), /no CLI/);
  assert.equal(current.starts.length + local.starts.length + unavailable.starts.length, 0);
  const failing = fixture(available, { startError: new Error("spawn failed") });
  await assert.rejects(failing.updater.apply(newer), /spawn failed/);
  await assert.rejects(failing.updater.apply(newer), /spawn failed/, "a failed start must not block a retry");
  assert.equal(failing.starts.length, 2);
});
