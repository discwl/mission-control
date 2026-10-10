import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { setJsoncListItem, setJsoncMember, setTomlKey } = require("./config-edits.ts");
const { parseJsonc, parseToml } = require("./config-parsers.ts");
const { applyToggle, atomicWrite, describeToggles, planToggle } = require("./mcp-toggle.ts");
const { collectToolsInventory } = require("./tools-inventory.ts");

// Every test works on a temporary copy of the fixture home; real provider configs are never touched.
const fixtureHome = fileURLToPath(new URL("./fixtures/tools-inventory/home/", import.meta.url));
const scratch = [];
after(() => { for (const path of scratch) rmSync(path, { recursive: true, force: true }); });

function tempDir(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

/** A host over a fresh copy of the fixture home. The fake Codex CLI reports what config.toml says. */
function toggleHost({ codex = "follow", writeFile, env = {} } = {}) {
  const home = tempDir("mc-toggle-home-");
  cpSync(fixtureHome, home, { recursive: true });
  const backupDir = join(tempDir("mc-toggle-backups-"), "config-backups");
  const configPath = join(home, ".codex", "config.toml");
  let seconds = 0;
  const host = {
    home, env, backupDir, writeFile,
    now: () => new Date(Date.UTC(2026, 8, 26, 12, 0, seconds++)),
    async codexMcpList() {
      if (codex === "missing") return null;
      const servers = parseToml(readFileSync(configPath, "utf8")).mcp_servers ?? {};
      return { servers: Object.entries(servers).map(([name, server]) => ({ name, enabled: codex === "always-on" ? true : server.enabled !== false })) };
    },
  };
  return { host, home, backupDir, read: path => readFileSync(join(home, path), "utf8"), write: (path, content) => writeFileSync(join(home, path), content) };
}

/** The lines that differ between two texts: everything outside one changed block must be identical. */
function diff(before, after) {
  const a = before.split("\n"), b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const clean = lines => lines.map(line => line.replace(/\r$/, ""));
  // Line endings follow the file: a CRLF file (as Git checks fixtures out on Windows) gets no bare LF.
  const crlf = text => (text.match(/\r\n/g) ?? []).length === (text.match(/\n/g) ?? []).length;
  assert.equal(crlf(after), crlf(before), "the edit changed the file's line endings");
  return { removed: clean(a.slice(start, a.length - end)), added: clean(b.slice(start, b.length - end)) };
}

async function change(host, target) {
  const plan = await planToggle(host, target);
  return { plan, result: await applyToggle(host, { ...target, fingerprint: plan.fingerprint }) };
}

const backups = backupDir => existsSync(backupDir) ? readdirSync(backupDir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()) : [];
const noSecrets = value => assert.doesNotMatch(JSON.stringify(value), /SECRET-SENTINEL/);

// ---------- the edits themselves ----------

test("TOML: set, add and remove one key in a [table], keeping comments and line endings", () => {
  const source = "# top\r\n[mcp_servers.a]\r\ncommand = \"x\" # why\r\n\r\n[mcp_servers.a.env]\r\nKEY = \"v\"\r\n";
  const off = setTomlKey(source, ["mcp_servers", "a"], "enabled", false);
  assert.equal(off, "# top\r\n[mcp_servers.a]\r\ncommand = \"x\" # why\r\nenabled = false\r\n\r\n[mcp_servers.a.env]\r\nKEY = \"v\"\r\n");
  assert.equal(setTomlKey(off, ["mcp_servers", "a"], "enabled", true), off.replace("enabled = false", "enabled = true"));
  assert.equal(setTomlKey(off, ["mcp_servers", "a"], "enabled", null), source);
  // A multi-line value and a quoted table name.
  const quoted = "[mcp_servers.\"my server\"]\nargs = [\n  \"[not a header]\",\n]\n";
  assert.equal(setTomlKey(quoted, ["mcp_servers", "my server"], "enabled", false), `${quoted}enabled = false\n`);
  // An empty table at the end of a file without a final newline.
  assert.equal(setTomlKey("[mcp_servers.b]", ["mcp_servers", "b"], "enabled", false), "[mcp_servers.b]\nenabled = false\n");
  assert.throws(() => setTomlKey("[mcp_servers]\nc = { command = \"x\" }\n", ["mcp_servers", "c"], "enabled", false));
});

test("JSONC: add and remove a member in both comma styles, and keep a member's comment", () => {
  const plain = "{\n  // servers\n  \"a\": {\n    \"type\": \"local\" // why\n  }\n}\n";
  const added = setJsoncMember(plain, ["a", "enabled"], "false");
  assert.equal(added, "{\n  // servers\n  \"a\": {\n    \"type\": \"local\", // why\n    \"enabled\": false\n  }\n}\n");
  assert.equal(setJsoncMember(added, ["a", "enabled"], null), plain);
  const trailing = "{\r\n  \"a\": {\r\n    \"type\": \"local\",\r\n  },\r\n}\r\n";
  const addedTrailing = setJsoncMember(trailing, ["a", "enabled"], "false");
  assert.equal(addedTrailing, "{\r\n  \"a\": {\r\n    \"type\": \"local\",\r\n    \"enabled\": false,\r\n  },\r\n}\r\n");
  assert.equal(setJsoncMember(addedTrailing, ["a", "enabled"], null), trailing);
  assert.equal(setJsoncMember("{ \"a\": { \"type\": \"x\" } }", ["a", "enabled"], "false"), "{ \"a\": { \"type\": \"x\", \"enabled\": false } }");
});

test("JSONC lists: add and remove a name, dropping the member when the list empties", () => {
  const source = "{\n  \"toolSearch\": false,\n  \"disabledMcpServers\": [\"one\"]\n}\n";
  const two = setJsoncListItem(source, ["disabledMcpServers"], "two", true);
  assert.equal(two, "{\n  \"toolSearch\": false,\n  \"disabledMcpServers\": [\"one\", \"two\"]\n}\n");
  assert.equal(setJsoncListItem(two, ["disabledMcpServers"], "two", false), source);
  assert.equal(setJsoncListItem(two, ["disabledMcpServers"], "one", false), source.replace("\"one\"", "\"two\""));
  const none = setJsoncListItem(source, ["disabledMcpServers"], "one", false);
  assert.equal(none, "{\n  \"toolSearch\": false\n}\n");
  assert.equal(setJsoncListItem(none, ["disabledMcpServers"], "one", true), source);
  const multiline = "{\n  \"disabledMcpServers\": [\n    \"one\",\n  ]\n}\n";
  const grown = setJsoncListItem(multiline, ["disabledMcpServers"], "two", true);
  assert.equal(grown, "{\n  \"disabledMcpServers\": [\n    \"one\",\n    \"two\",\n  ]\n}\n");
  assert.equal(setJsoncListItem(grown, ["disabledMcpServers"], "two", false), multiline);
});

test("removing a key keeps a comment someone wrote on its line, and refuses to drop one beside it", () => {
  const toml = "[mcp_servers.a]\ncommand = \"x\"\nenabled = false # paused until the outage is fixed\n";
  assert.equal(setTomlKey(toml, ["mcp_servers", "a"], "enabled", null), "[mcp_servers.a]\ncommand = \"x\"\n# paused until the outage is fixed\n");
  const jsonc = "{\n  \"a\": {\n    \"type\": \"local\",\n    \"enabled\": false // mine\n  }\n}\n";
  assert.equal(setJsoncMember(jsonc, ["a", "enabled"], null), "{\n  \"a\": {\n    \"type\": \"local\"\n    // mine\n  }\n}\n");
  parseJsonc(setJsoncMember(jsonc, ["a", "enabled"], null));
  assert.throws(() => setJsoncMember("{ \"a\": { \"enabled\": false, /* keep */ \"type\": \"x\" } }", ["a", "enabled"], null), /comment/);
});

test("a string JSONC accepts but JSON doesn't is refused with the safe message", async () => {
  const { host, write, read } = toggleHost();
  write(".config/opencode/opencode.jsonc", "{\n  \"mcp\": {\n    \"tabbed\": { \"type\": \"local\", \"command\": [\"a\tb\"] }\n  }\n}\n");
  const before = read(".config/opencode/opencode.jsonc");
  await assert.rejects(planToggle(host, { provider: "opencode", server: "tabbed", enabled: false }), /can't be edited safely here \(a value can't be read\); nothing was written/);
  assert.equal(read(".config/opencode/opencode.jsonc"), before);
});

test("the atomic write keeps a symlinked config's link and the file's permissions", async t => {
  const dir = tempDir("mc-toggle-link-");
  const target = join(dir, "real.toml");
  const link = join(dir, "config.toml");
  writeFileSync(target, "a = 1\n", { mode: 0o600 });
  try { symlinkSync(target, link); } catch { t.skip("symlinks need extra rights on this host"); return; }
  await atomicWrite(link, "a = 2\n");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(target, "utf8"), "a = 2\n");
  if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o600);
});

// ---------- Codex ----------

test("Codex: turn a server off and back on; only its enabled line changes", async () => {
  const { host, backupDir, read } = toggleHost();
  const original = read(".codex/config.toml");
  const off = await change(host, { provider: "codex", server: "gortex", enabled: false });
  assert.deepEqual({ file: off.plan.file, key: off.plan.key, before: off.plan.before, after: off.plan.after }, {
    file: join("~", ".codex", "config.toml"), key: "[mcp_servers.gortex] enabled", before: "not set (on)", after: "false (off)",
  });
  assert.equal(off.result.changed, true);
  assert.deepEqual(diff(original, read(".codex/config.toml")), { removed: [], added: ["enabled = false"] });
  assert.ok(off.result.checks.some(check => check.includes("codex mcp list --json reports it off")));
  assert.deepEqual(off.result.undo, { provider: "codex", server: "gortex", enabled: null });
  assert.equal(parseToml(read(".codex/config.toml")).mcp_servers.gortex.enabled, false);

  // Undo removes the key it added, so the file is back to the original bytes.
  await change(host, off.result.undo);
  assert.equal(read(".codex/config.toml"), original);

  // Turn on, after turning off, sets the key to true instead.
  await change(host, { provider: "codex", server: "gortex", enabled: false });
  const on = await change(host, { provider: "codex", server: "gortex", enabled: true });
  assert.equal(on.plan.before, "false (off)");
  assert.deepEqual(diff(original, read(".codex/config.toml")), { removed: [], added: ["enabled = true"] });

  // A server that is already off: only the value changes.
  const parked = await change(host, { provider: "codex", server: "parked", enabled: true });
  assert.deepEqual(parked.result.undo, { provider: "codex", server: "parked", enabled: false });
  const lines = diff(original, read(".codex/config.toml"));
  assert.deepEqual(lines.removed.filter(line => line.startsWith("enabled")), ["enabled = false"]);

  // Every applied change was backed up into Mission Control's folder, not next to the config.
  const saved = backups(backupDir);
  assert.equal(saved.length, 5);
  for (const entry of saved) assert.match(entry.name, /^2026-09-26T12-00-\d\d-\d{3}Z-config\.toml$/);
  assert.deepEqual(readdirSync(join(host.home, ".codex")).filter(name => /mission-control|\.bak|backup/i.test(name)), []);
  noSecrets([off, on, parked]);
});

test("Codex: Undo keeps edits made to the file after the change", async () => {
  const { host, read, write } = toggleHost();
  const off = await change(host, { provider: "codex", server: "gortex", enabled: false });
  write(".codex/config.toml", read(".codex/config.toml").replace("startup_timeout_sec = 90", "startup_timeout_sec = 120"));
  const later = read(".codex/config.toml");
  await change(host, off.result.undo);
  assert.deepEqual(diff(later, read(".codex/config.toml")), { removed: ["enabled = false"], added: [] });
});

test("Codex: an unchanged request writes nothing", async () => {
  const { host, backupDir, read } = toggleHost();
  const original = read(".codex/config.toml");
  const { plan, result } = await change(host, { provider: "codex", server: "gortex", enabled: true });
  assert.equal(plan.unchanged, true);
  assert.equal(result.changed, false);
  assert.equal(read(".codex/config.toml"), original);
  assert.equal(backups(backupDir).length, 0);
});

// ---------- OpenCode ----------

test("OpenCode JSONC with comments: turn servers off and on; only the enabled key changes", async () => {
  const { host, read } = toggleHost();
  const path = ".config/opencode/opencode.jsonc";
  const original = read(path);
  const off = await change(host, { provider: "opencode", server: "remote-search", enabled: false });
  assert.equal(off.plan.key, "mcp.remote-search.enabled");
  assert.equal(off.plan.file, join("~", ".config", "opencode", "opencode.jsonc"));
  assert.deepEqual(diff(original, read(path)), { removed: [], added: ["      \"enabled\": false,"] });
  assert.equal(parseJsonc(read(path)).mcp["remote-search"].enabled, false);
  await change(host, off.result.undo);
  assert.equal(read(path), original);

  // The parked server keeps its comment when turned on.
  const on = await change(host, { provider: "opencode", server: "parked", enabled: true });
  assert.deepEqual(diff(original, read(path)), {
    removed: ["      \"enabled\": false, // turned off without deleting"],
    added: ["      \"enabled\": true, // turned off without deleting"],
  });
  await change(host, on.result.undo);
  assert.equal(read(path), original);
  noSecrets([off, on]);
});

test("OpenCode JSON without trailing commas stays valid JSON", async () => {
  const { host, read, write } = toggleHost();
  const path = ".config/opencode/opencode.jsonc";
  const source = "{\n  // plain\n  \"mcp\": {\n    \"solo\": {\n      \"type\": \"local\",\n      \"command\": [\"solo\"]\n    }\n  }\n}\n";
  write(path, source);
  const off = await change(host, { provider: "opencode", server: "solo", enabled: false });
  assert.deepEqual(diff(source, read(path)), { removed: ["      \"command\": [\"solo\"]"], added: ["      \"command\": [\"solo\"],", "      \"enabled\": false"] });
  JSON.parse(read(path).replace("  // plain\n", ""));
  await change(host, off.result.undo);
  assert.equal(read(path), source);
});

// ---------- Copilot ----------

test("Copilot: disabledMcpServers in settings.json, off and back on", async () => {
  const { host, read } = toggleHost();
  const path = ".copilot/settings.json";
  const original = read(path);
  const off = await change(host, { provider: "copilot", server: "gortex", enabled: false });
  assert.deepEqual({ key: off.plan.key, before: off.plan.before, after: off.plan.after }, { key: "disabledMcpServers", before: "not listed (on)", after: "listed (off)" });
  assert.deepEqual(diff(original, read(path)), { removed: ["  \"disabledMcpServers\": [\"tickets\"],"], added: ["  \"disabledMcpServers\": [\"tickets\", \"gortex\"],"] });
  await change(host, off.result.undo);
  assert.equal(read(path), original);

  // Turning the last listed server on removes the list, as Copilot does; turning it off again restores it.
  const on = await change(host, { provider: "copilot", server: "tickets", enabled: true });
  assert.deepEqual(parseJsonc(read(path)), { toolSearch: false, enabledPlugins: { "notes-kit@awesome-copilot": false } });
  await change(host, on.result.undo);
  // Undo re-adds the removed list as the last member, so the settings match but the key order may not.
  assert.deepEqual(parseJsonc(read(path)), parseJsonc(original));
  assert.equal(read(path).replace(/\s+/g, "").length, original.replace(/\s+/g, "").length);
  noSecrets([off, on]);
});

test("Copilot: a missing settings.json is created, with no backup", async () => {
  const { host, backupDir, read, home } = toggleHost();
  unlinkSync(join(home, ".copilot", "settings.json"));
  const off = await change(host, { provider: "copilot", server: "gortex", enabled: false });
  assert.equal(off.result.backup, null);
  assert.deepEqual(parseJsonc(read(".copilot/settings.json")), { disabledMcpServers: ["gortex"] });
  await change(host, off.result.undo);
  assert.deepEqual(parseJsonc(read(".copilot/settings.json")), {});
  assert.equal(backups(backupDir).length, 1);
});

// ---------- refusals ----------

test("a file that changed after the confirmation is not written", async () => {
  const { host, backupDir, read, write } = toggleHost();
  const plan = await planToggle(host, { provider: "codex", server: "gortex", enabled: false });
  write(".codex/config.toml", read(".codex/config.toml").replace("gpt-test-search", "gpt-other"));
  const edited = read(".codex/config.toml");
  await assert.rejects(applyToggle(host, { provider: "codex", server: "gortex", enabled: false, fingerprint: plan.fingerprint }), /changed after you confirmed, so nothing was written/);
  assert.equal(read(".codex/config.toml"), edited);
  assert.equal(backups(backupDir).length, 0);
});

test("a failed read-back puts the original back while the file still holds what was written", async () => {
  const { host, backupDir, read } = toggleHost({ codex: "always-on" });
  const original = read(".codex/config.toml");
  await assert.rejects(change(host, { provider: "codex", server: "gortex", enabled: false }), error => {
    assert.match(error.message, /Read-back failed for .*config\.toml: codex mcp list --json reports it on\. The original file was put back\. Backup: /);
    assert.doesNotMatch(error.message, /SECRET-SENTINEL/);
    return true;
  });
  assert.equal(read(".codex/config.toml"), original);
  const [saved] = backups(backupDir);
  assert.equal(readFileSync(join(saved.parentPath ?? saved.path, saved.name), "utf8"), original);
});

test("a write that doesn't stick is reported, and a file changed since is left alone", async () => {
  const other = "{\n  \"someone\": \"else\"\n}\n";
  const { host, read } = toggleHost({ writeFile: async path => writeFileSync(path, other) });
  await assert.rejects(change(host, { provider: "opencode", server: "local-db", enabled: false }), /Read-back failed for .*opencode\.jsonc: the file doesn't hold what was written\. The file was left as it is now/);
  assert.equal(read(".config/opencode/opencode.jsonc"), other);
});

test("read-only servers say why, and Claude Code has no switch", async () => {
  const { host, write } = toggleHost();
  const reason = async (provider, server) => {
    await assert.rejects(planToggle(host, { provider, server, enabled: false }), /can't be changed here/);
  };
  await reason("copilot", "github-mcp-server");
  await reason("codex", "not-in-config");
  write(".codex/config.toml", "[mcp_servers]\ninline = { command = \"x\" }\n");
  await assert.rejects(planToggle(host, { provider: "codex", server: "inline", enabled: false }), /written inline/);
  write(".config/opencode/opencode.json", "{ \"mcp\": { \"parked\": { \"type\": \"local\" } } }");
  await assert.rejects(planToggle(host, { provider: "opencode", server: "parked", enabled: true }), /defined in .*opencode\.json and .*opencode\.jsonc/);
  write(".copilot/config.json", "{ \"disabledMcpServers\": [] }");
  await assert.rejects(planToggle(host, { provider: "copilot", server: "gortex", enabled: false }), /config\.json also has disabledMcpServers/);
});

test("a Copilot plugin server named like one in mcp-config.json stays read-only; only the config one gets the switch", async () => {
  const { host } = toggleHost();
  const [copilot] = await describeToggles(host, [{
    id: "copilot",
    servers: [
      { name: "gortex", source: join("~", ".copilot", "mcp-config.json") },
      { name: "gortex", source: "Copilot plugin deploy-helper@copilot-plugins" },
      { name: "github-mcp-server", source: "Built in" },
    ],
  }]);
  const [config, plugin, builtIn] = copilot.servers.map(server => server.toggle);
  assert.deepEqual(config, { enabled: true, file: join("~", ".copilot", "settings.json"), key: "disabledMcpServers", readOnly: null });
  assert.match(plugin.readOnly, /comes from a Copilot plugin/);
  assert.equal(plugin.enabled, null);
  assert.match(builtIn.readOnly, /Built in/);
});

test("the inventory shows each server's switch without secrets", async () => {
  const { host } = toggleHost();
  const inventory = await collectToolsInventory({
    ...host, platform: process.platform, claudeManagedSettings: null,
    async findCommand() { return "found"; }, async probeUrl() { return { state: "ok", label: "Reachable" }; },
    async codexMcpList() { return null; },
  });
  const toggles = Object.fromEntries(inventory.providers.map(provider => [provider.id, Object.fromEntries(provider.servers.map(server => [server.name, server.toggle ?? null]))]));
  assert.deepEqual(Object.values(toggles.claude).filter(Boolean), []);
  assert.deepEqual(toggles.codex.gortex, { enabled: true, file: join("~", ".codex", "config.toml"), key: "[mcp_servers.gortex] enabled", readOnly: null });
  assert.equal(toggles.codex.parked.enabled, false);
  assert.equal(toggles.opencode.parked.enabled, false);
  assert.equal(toggles.opencode["local-db"].key, "mcp.local-db.enabled");
  assert.deepEqual([toggles.copilot.tickets.enabled, toggles.copilot.gortex.enabled], [false, true]);
  assert.match(toggles.copilot["github-mcp-server"].readOnly, /Built in/);
  noSecrets(inventory.providers.map(provider => provider.servers));
  assert.equal(relative(host.home, host.backupDir).startsWith(".."), true);
});
