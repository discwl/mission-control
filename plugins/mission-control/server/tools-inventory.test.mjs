import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { ConfigParseError, parseJsonc, parseToml } = require("./config-parsers.ts");
const { claudeToolSearch, codexServers, codexToolSearch, collectToolsInventory, commandName, copilotPlugins, copilotPluginSkillPaths, copilotToolSearch, probeAddress, sanitizeUrl, skillFrontMatter } = require("./tools-inventory.ts");

const home = fileURLToPath(new URL("./fixtures/tools-inventory/home/", import.meta.url)).replace(/[\\/]$/, "");
const fixture = path => readFileSync(join(home, path), "utf8");

// A host over the fixture home. Commands are looked up, never run; URLs are recorded, never fetched.
function fixtureHost({ env = {}, codex = null, missing = [] } = {}) {
  const probed = [], looked = [];
  const host = {
    home, env, platform: process.platform, claudeManagedSettings: null,
    now: () => new Date("2026-09-26T12:00:00.000Z"),
    async findCommand(command) { looked.push(command); return missing.includes(command) ? "missing" : "found"; },
    async probeUrl(url) { probed.push(url); return url.includes("notion") ? { state: "warning", label: "Reachable; asks for sign-in (HTTP 401)" } : { state: "ok", label: "Reachable (HTTP 405)" }; },
    async codexMcpList() { return codex; },
  };
  return { host, probed, looked };
}

const provider = (inventory, id) => inventory.providers.find(entry => entry.id === id);
const server = (entry, name) => entry.servers.find(item => item.name === name);
const skillNames = folder => folder.skills.map(skill => skill.name);

// ---------- JSONC ----------

test("JSONC: comments, trailing commas and comment markers inside strings", () => {
  const value = parseJsonc(fixture(".config/opencode/opencode.jsonc"));
  assert.deepEqual(Object.keys(value.mcp), ["local-db", "remote-search", "parked"]);
  assert.equal(value.mcp.parked.enabled, false);
  assert.equal(value.instructions.length, 3);
  assert.deepEqual(parseJsonc('{ "a": "x // y", "b": "/* z */", }'), { a: "x // y", b: "/* z */" });
  assert.deepEqual(parseJsonc("\uFEFF[1, 2.5e1, -3, true, null, \"\\u00e9\\n\",]"), [1, 25, -3, true, null, "é\n"]);
});

test("JSONC errors give a position without quoting the file", () => {
  for (const [input, line, column] of [['{\n  "token": "SECRET-SENTINEL" "x"\n}', 2, 30], ['{ "a": SECRET-SENTINEL }', 1, 8], ['{ "a": "SECRET-SENTINEL', 1, 8], ["/* SECRET-SENTINEL", 1, 1]]) {
    assert.throws(() => parseJsonc(input), error => {
      assert.ok(error instanceof ConfigParseError);
      assert.equal(error.line, line);
      assert.equal(error.column, column);
      assert.doesNotMatch(error.message, /SENTINEL/);
      return true;
    });
  }
});

test("JSONC keeps __proto__ as a plain key", () => {
  const value = parseJsonc('{ "__proto__": { "polluted": true } }');
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(value), ["__proto__"]);
});

// ---------- TOML ----------

test("TOML: the Codex fixture's tables, keys, strings, numbers and arrays", () => {
  const config = parseToml(fixture(".codex/config.toml"));
  assert.equal(config.model, "gpt-test-search");
  assert.equal(config.model_reasoning_effort, "high");
  assert.deepEqual(config.notify, ["node", "C:\\tools\\notify.js"]);
  assert.equal(config.approval_timeout, 1000);
  assert.equal(config.hex_value, 255);
  assert.equal(config.started, "2026-09-26T10:00:00Z");
  assert.equal(config.greeting, "Hello world");
  assert.equal(config.path_literal, "C:\\no\\escapes");
  assert.deepEqual(config.features, { js_repl: true, code_mode: { direct_only_tool_namespaces: ["gortex", "other"] } });
  assert.deepEqual(Object.keys(config.mcp_servers), ["gortex", "docs-http", "parked"]);
  assert.equal(config.mcp_servers.gortex.command, "C:\\Users\\someone\\bin\\gortex.exe");
  assert.deepEqual(config.mcp_servers["docs-http"].http_headers, { "X-Api-Key": "SECRET-SENTINEL-toml-header" });
  assert.equal(config.mcp_servers.parked.tools.search.approval_mode, "never");
  assert.equal(config.plugins["browser@openai-bundled"].enabled, true);
  assert.deepEqual(config.skills.config.map(entry => entry.enabled), [false, true]);
  assert.equal(config.projects["C:\\Code\\example"].trust_level, "trusted");
});

test("TOML: dotted keys, array tables with sub-tables, escapes and number forms", () => {
  const value = parseToml([
    'a.b.c = 1',
    'a.b.d = "tab\\there \\u00e9 \\U0001F600"',
    "site.'quoted key' = true",
    '[[fruit]]',
    'name = "apple"',
    '[fruit.physical]',
    'color = "red"',
    '[[fruit]]',
    'name = "pear"',
    'nums = [ +1, -2, 3.5, 1e3, 0o17, 0b101, inf, ]',
    'inline = { x = 1, y.z = "two" }',
    'time = 07:32:00',
    'day = 1979-05-27',
    'quotes = """one "two" ""three"""""',
  ].join("\n"));
  assert.deepEqual(value.a, { b: { c: 1, d: "tab\there é 😀" } });
  assert.equal(value.site["quoted key"], true);
  assert.deepEqual(value.fruit[0], { name: "apple", physical: { color: "red" } });
  assert.equal(value.fruit[1].name, "pear");
  assert.deepEqual(value.fruit[1].nums, [1, -2, 3.5, 1000, 15, 5, Infinity]);
  assert.deepEqual(value.fruit[1].inline, { x: 1, y: { z: "two" } });
  assert.equal(value.fruit[1].time, "07:32:00");
  assert.equal(value.fruit[1].day, "1979-05-27");
  assert.equal(value.fruit[1].quotes, 'one "two" ""three""');
});

test("TOML errors: duplicates, bad values and unterminated strings, with positions only", () => {
  const cases = [
    ["a = 1\na = 2", 2, 1],
    ["[t]\nx = 1\n[t]", 3, 1],
    ["x = { a = 1 }\nx.b = 2", 2, 1],
    ['token = "SECRET-SENTINEL', 1, 9],
    ["key = SECRET-SENTINEL", 1, 7],
    ["key = 1 SECRET-SENTINEL", 1, 9],
    ["arr = [1, 2", 1, 12],
  ];
  for (const [input, line, column] of cases) {
    assert.throws(() => parseToml(input), error => {
      assert.ok(error instanceof ConfigParseError, input);
      assert.deepEqual([error.line, error.column], [line, column], input);
      assert.doesNotMatch(error.message, /SENTINEL/);
      return true;
    });
  }
});

// ---------- helpers ----------

test("URLs lose credentials, query, fragment and key-like path segments", () => {
  assert.equal(sanitizeUrl("https://mcp.example.com/mcp"), "https://mcp.example.com/mcp");
  assert.equal(sanitizeUrl("https://user:pw@mcp.example.com:8443/v1/?api_key=abc#x"), "https://mcp.example.com:8443/v1/ (credentials or parameters hidden)");
  assert.equal(sanitizeUrl("https://mcp.example.com/fixture-path-key-0123456789abcdef/sse"), "https://mcp.example.com/…/sse");
  assert.equal(sanitizeUrl("https://mcp.example.com/"), "https://mcp.example.com");
  assert.equal(sanitizeUrl("not a url"), null);
  assert.equal(sanitizeUrl("file:///C:/secret/path"), "file:…");
});

test("the health check requests the URL without user info, query or fragment", () => {
  const credentialed = "https://user:SECRET-SENTINEL-pass@mcp.example.com:8443/v1/fixture-path-key-0123456789abcdef?api_key=SECRET-SENTINEL#SECRET-SENTINEL";
  const address = probeAddress(credentialed);
  assert.equal(address, "https://mcp.example.com:8443/v1/fixture-path-key-0123456789abcdef");
  // fetch refuses URLs that carry credentials; the stripped address is accepted.
  assert.throws(() => new Request(credentialed), TypeError);
  assert.doesNotThrow(() => new Request(address));
  assert.equal(probeAddress("http://localhost:3000/mcp"), "http://localhost:3000/mcp");
  assert.equal(probeAddress("wss://mcp.example.com/ws"), null);
  assert.equal(probeAddress("not a url"), null);
});

test("only the command's file name is kept", () => {
  assert.equal(commandName("C:\\tools\\gortex.exe"), "gortex.exe");
  assert.equal(commandName("/usr/local/bin/uvx"), "uvx");
  assert.equal(commandName("npx"), "npx");
});

test("skill front matter: plain, quoted, single-quoted and folded values", () => {
  assert.deepEqual(skillFrontMatter(fixture(".claude/skills/review-helper/SKILL.md")), { name: "review-helper", description: "Reviews a change for bugs and missing tests." });
  assert.deepEqual(skillFrontMatter(fixture(".claude/skills/shared-skill/SKILL.md")), { name: "shared-skill", description: 'A skill copied into several folders: "shared".' });
  assert.deepEqual(skillFrontMatter(fixture(".agents/skills/turned-off/SKILL.md")), { name: "turned-off", description: "Turned off in Codex's skills.config." });
  assert.deepEqual(skillFrontMatter("# No front matter"), { name: null, description: null });
});

// ---------- tool search ----------

const envFrom = values => name => values[name] === undefined ? null : { value: values[name], source: "settings.json" };

test("Claude tool search follows ENABLE_TOOL_SEARCH, the base URL and the betas switch", () => {
  assert.equal(claudeToolSearch(envFrom({}), []).verdict, "on");
  assert.equal(claudeToolSearch(envFrom({ ENABLE_TOOL_SEARCH: "" }), []).verdict, "on");
  assert.equal(claudeToolSearch(envFrom({ ENABLE_TOOL_SEARCH: "false" }), []).verdict, "off");
  assert.equal(claudeToolSearch(envFrom({ ENABLE_TOOL_SEARCH: "auto:10" }), []).verdict, "on");
  assert.equal(claudeToolSearch(envFrom({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }), []).verdict, "off");
  const proxy = claudeToolSearch(envFrom({ ANTHROPIC_BASE_URL: "https://proxy.example/SECRET-SENTINEL" }), []);
  assert.equal(proxy.verdict, "off");
  assert.doesNotMatch(JSON.stringify(proxy), /SENTINEL|proxy\.example/);
  assert.equal(claudeToolSearch(envFrom({ ANTHROPIC_BASE_URL: "https://proxy.example", ENABLE_TOOL_SEARCH: "true" }), []).verdict, "on");
  assert.equal(claudeToolSearch(envFrom({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }), []).verdict, "on");
  const odd = claudeToolSearch(envFrom({ ENABLE_TOOL_SEARCH: "SECRET-SENTINEL" }), []);
  assert.equal(odd.verdict, "unknown");
  assert.doesNotMatch(odd.reason, /SENTINEL/);
});

test("Codex tool search depends on the configured model", () => {
  const cache = JSON.parse(fixture(".codex/models_cache.json"));
  assert.equal(codexToolSearch({ model: "gpt-test-search" }, cache).verdict, "on");
  assert.equal(codexToolSearch({ model: "gpt-test-plain" }, cache).verdict, "off");
  assert.equal(codexToolSearch({ model: "gpt-unlisted" }, cache).verdict, "unknown");
  assert.equal(codexToolSearch({}, cache).verdict, "unknown");
  assert.equal(codexToolSearch({ model: "gpt-unlisted", profile: "p", profiles: { p: { model: "gpt-test-plain" } } }, cache).verdict, "off");
});

test("Copilot tool search reads toolSearch from settings, else unknown", () => {
  assert.equal(copilotToolSearch([{ label: "settings.json", value: { toolSearch: true } }], []).verdict, "on");
  assert.equal(copilotToolSearch([{ label: "settings.json", value: { toolSearch: false } }], []).verdict, "off");
  assert.equal(copilotToolSearch([{ label: "settings.json", value: null }], []).verdict, "unknown");
});

test("Copilot plugins: installedPlugins lists them, enabledPlugins switches them, manifests name their skill folders", () => {
  const dir = join(home, ".copilot");
  const config = JSON.parse(fixture(".copilot/config.json"));
  assert.deepEqual(copilotPlugins(config, { enabledPlugins: { "notes-kit@awesome-copilot": false } }, dir).map(plugin => [plugin.name, plugin.enabled, plugin.path]), [
    ["deploy-helper", true, join(dir, "installed-plugins", "copilot-plugins", "deploy-helper")],
    ["notes-kit", false, join(dir, "installed-plugins", "awesome-copilot", "notes-kit")],
    ["removed-by-hand", true, join(dir, "installed-plugins", "copilot-plugins", "removed-by-hand")],
  ]);
  const direct = { installedPlugins: [{ name: "direct", marketplace: "", enabled: false, cache_path: join(dir, "installed-plugins", "_direct", "abc") }, { marketplace: "no-name" }] };
  assert.deepEqual(copilotPlugins(direct, null, dir), [{ name: "direct", marketplace: "", enabled: false, path: join(dir, "installed-plugins", "_direct", "abc") }]);
  assert.deepEqual(copilotPlugins(null, null, dir), []);

  const root = join(dir, "installed-plugins", "m", "p");
  assert.deepEqual(copilotPluginSkillPaths(root, null), [join(root, "skills")]);
  assert.deepEqual(copilotPluginSkillPaths(root, { skills: "./more" }), [join(root, "more")]);
  assert.deepEqual(copilotPluginSkillPaths(root, { skills: ["a", "../outside", "b/c"] }), [join(root, "a"), join(root, "b", "c")]);
  assert.deepEqual(copilotPluginSkillPaths(root, { skills: { paths: ["extra"] } }), [join(root, "skills"), join(root, "extra")]);
  assert.deepEqual(copilotPluginSkillPaths(root, { skills: { paths: ["extra"], exclusive: true } }), [join(root, "extra")]);
  assert.deepEqual(copilotPluginSkillPaths(root, { skills: { paths: "bad" } }), []);
  // The default folder named again, in any spelling, is listed once.
  assert.deepEqual(copilotPluginSkillPaths(root, { skills: { paths: ["./skills", "skills/", "extra", "extra"] } }), [join(root, "skills"), join(root, "extra")]);
});

test("Codex's list output adds plugin servers and sign-in state without copying secrets", () => {
  const listed = [
    { name: "gortex", enabled: true, auth_status: "unsupported", transport: { type: "stdio", command: "gortex.exe", args: ["SECRET-SENTINEL"], env: { K: "SECRET-SENTINEL" } } },
    { name: "docs", enabled: true, auth_status: "o_auth", transport: { type: "streamable_http", url: "https://docs.example/mcp", http_headers: { K: "SECRET-SENTINEL" } } },
    { name: "plugin-tool", enabled: false, disabled_reason: "requirements", auth_status: "unsupported", transport: { type: "stdio", command: "C:\\p\\node.exe", args: [] } },
    { name: "odd", enabled: false, disabled_reason: "SECRET-SENTINEL\nmultiline reason text", auth_status: "not_logged_in", transport: { type: "streamable_http", url: "https://odd.example/mcp" } },
  ];
  const drafts = codexServers({ mcp_servers: { gortex: { command: "gortex.exe" }, docs: { url: "https://docs.example/mcp" } } }, listed, "~/.codex/config.toml");
  const byName = Object.fromEntries(drafts.map(draft => [draft.name, draft]));
  assert.deepEqual(drafts.map(draft => draft.name), ["docs", "gortex", "odd", "plugin-tool"]);
  assert.equal(byName.docs.signIn, "signed-in");
  assert.equal(byName.gortex.signIn, "not-needed");
  assert.equal(byName["plugin-tool"].source, "Codex plugin");
  assert.equal(byName["plugin-tool"].command, "node.exe");
  assert.equal(byName["plugin-tool"].enabled, false);
  assert.equal(byName["plugin-tool"].enabledNote, "Reason: requirements.");
  assert.equal(byName.odd.signIn, "needs-sign-in");
  assert.equal(byName.odd.enabledNote, null);
  const shown = drafts.map(({ check, ...rest }) => rest);
  assert.doesNotMatch(JSON.stringify(shown), /SENTINEL/);
});

// ---------- the whole inventory over the fixture home ----------

test("the inventory for each provider matches the fixture home", async () => {
  const codexList = [
    { name: "gortex", enabled: true, auth_status: "unsupported", transport: { type: "stdio", command: "gortex.exe" } },
    { name: "cua_repl", enabled: true, auth_status: "unsupported", transport: { type: "stdio", command: "C:\\x\\node.exe", args: ["SECRET-SENTINEL-cli"] } },
  ];
  const { host, probed, looked } = fixtureHost({ codex: { servers: codexList }, missing: ["uvx"] });
  const inventory = await collectToolsInventory(host);
  assert.equal(inventory.checkedAt, "2026-09-26T12:00:00.000Z");
  assert.deepEqual(inventory.providers.map(entry => entry.id), ["claude", "codex", "opencode", "copilot"]);
  for (const entry of inventory.providers) {
    assert.equal(entry.found, true, entry.id);
    assert.deepEqual(entry.errors, [], entry.id);
  }

  const claude = provider(inventory, "claude");
  assert.deepEqual(claude.servers.map(item => [item.name, item.transport, item.signIn]), [
    ["linear", "http", "signed-in"], ["local-tool", "stdio", "not-needed"], ["notion", "sse", "needs-sign-in"], ["untyped", "stdio", "not-needed"],
  ]);
  assert.equal(server(claude, "untyped").enabledNote, "Turned off in 2 projects.");
  assert.equal(server(claude, "linear").enabledNote, "Turned off in 1 project.");
  assert.equal(server(claude, "local-tool").command, "local-tool.exe");
  assert.equal(server(claude, "linear").url, "https://mcp.linear.example/v1/… (credentials or parameters hidden)");
  assert.equal(server(claude, "notion").health.state, "warning");
  assert.match(server(claude, "notion").notes[0], /alwaysLoad/);
  assert.equal(claude.toolSearch.verdict, "on");
  assert.match(claude.toolSearch.reason, /auto:5.*notion/s);
  assert.deepEqual(claude.rules.map(rule => [rule.label, rule.state]), [["CLAUDE.md", "active"], ["rules/style/writing.md", "active"]]);
  assert.match(claude.rules[0].preview, /Prefer small, reviewed changes/);
  assert.deepEqual(claude.skillFolders.map(folder => [folder.label, skillNames(folder)]), [
    ["Skills", ["review-helper", "shared-skill"]],
    ["Plugin: market / helper-plugin / 1.0.0", ["plugin-skill"]],
  ]);
  assert.equal(claude.skillFolders[0].skills[0].description, "Reviews a change for bugs and missing tests.");
  assert.ok(!server(claude, "repo-only"), "project servers are out of scope");

  const codex = provider(inventory, "codex");
  assert.deepEqual(codex.servers.map(item => [item.name, item.transport, item.enabled, item.source]), [
    ["cua_repl", "stdio", true, "Codex plugin"],
    ["docs-http", "http", true, join("~", ".codex", "config.toml")],
    ["gortex", "stdio", true, join("~", ".codex", "config.toml")],
    ["parked", "stdio", false, join("~", ".codex", "config.toml")],
  ]);
  assert.equal(server(codex, "docs-http").url, "https://docs.example/mcp (credentials or parameters hidden)");
  assert.equal(codex.toolSearch.verdict, "on");
  assert.deepEqual(codex.rules.map(rule => [rule.label, rule.state]), [["AGENTS.override.md", "active"], ["AGENTS.md", "inactive"]]);
  assert.deepEqual(codex.skillFolders.map(folder => [folder.label, skillNames(folder)]), [
    ["Skills", ["shared-skill", "turned-off"]],
    ["Skills (old location)", ["old-skill"]],
    ["Plugin: market / sites / 0.1.0", ["site-builder"]],
  ]);
  assert.deepEqual(codex.skillFolders[0].skills.map(skill => skill.enabled), [true, false]);
  assert.deepEqual(codex.notes, []);

  const opencode = provider(inventory, "opencode");
  assert.deepEqual(opencode.servers.map(item => [item.name, item.transport, item.enabled, item.signIn, item.health.state]), [
    ["local-db", "stdio", true, "not-needed", "error"],
    ["parked", "stdio", false, "not-needed", "ok"],
    ["remote-search", "http", true, "signed-in", "ok"],
  ]);
  assert.equal(server(opencode, "local-db").command, "uvx");
  assert.equal(opencode.toolSearch.verdict, "not-supported");
  assert.deepEqual(opencode.rules.map(rule => [rule.label, rule.state]), [
    ["AGENTS.md", "missing"], ["CLAUDE.md (fallback)", "active"], ["Instruction: extra.md", "active"], ["Instruction pattern", "active"], ["Instruction URL", "active"],
  ]);
  assert.equal(opencode.rules[4].path, "https://example.com/rules.md (credentials or parameters hidden)");
  assert.deepEqual(opencode.skillFolders.map(folder => skillNames(folder)), [["oc-skill"], ["review-helper", "shared-skill"], ["shared-skill", "turned-off"]]);

  const copilot = provider(inventory, "copilot");
  assert.deepEqual(copilot.servers.map(item => [item.name, item.transport, item.enabled, item.signIn, item.source]), [
    ["deploy-api", "http", true, "unknown", "Copilot plugin deploy-helper@copilot-plugins"],
    ["deploy-local", "stdio", true, "not-needed", "Copilot plugin deploy-helper@copilot-plugins"],
    ["github-mcp-server", "http", true, "signed-in", "Built in"],
    ["gortex", "stdio", true, "not-needed", join("~", ".copilot", "mcp-config.json")],
    ["notes", "stdio", false, "not-needed", "Copilot plugin notes-kit@awesome-copilot"],
    ["tickets", "http", false, "unknown", join("~", ".copilot", "mcp-config.json")],
  ]);
  assert.equal(server(copilot, "deploy-api").url, "https://deploy.example/mcp (credentials or parameters hidden)");
  assert.equal(server(copilot, "deploy-local").command, "deploy-mcp");
  assert.equal(server(copilot, "notes").enabledNote, "The plugin notes-kit@awesome-copilot is turned off.");
  assert.equal(copilot.toolSearch.verdict, "off");
  assert.deepEqual(copilot.rules.map(rule => [rule.label, rule.state]), [["copilot-instructions.md", "active"], ["instructions/lang/typescript.instructions.md", "active"]]);
  assert.deepEqual(copilot.skillFolders.map(folder => [folder.label, skillNames(folder)]), [
    ["Skills", ["cp-skill"]],
    ["Shared skills", ["shared-skill", "turned-off"]],
    ["Plugin: copilot-plugins / deploy-helper", ["deploy-check"]],
    ["Plugin: awesome-copilot / notes-kit", ["note-taker"]],
  ]);
  assert.equal(copilot.skillFolders[2].note, "From the Copilot plugin deploy-helper@copilot-plugins.");
  assert.deepEqual(copilot.skillFolders.slice(2).map(folder => folder.skills[0].enabled), [true, false]);
  // The plugin's ${PLUGIN_ROOT} is filled in so the command can be looked up; it's never run.
  assert.ok(looked.some(command => /deploy-helper[\\/]+bin[\\/]deploy-mcp$/.test(command) && !command.includes("${")));

  // Remote servers are probed once each, without user info, query or fragment; stdio servers are only looked up.
  assert.deepEqual([...probed].sort(), [
    "https://deploy.example/mcp",
    "https://docs.example/mcp",
    "https://mcp.linear.example/v1/fixture-path-key-0123456789abcdef",
    "https://mcp.notion.example/sse",
    "https://search.example/mcp",
    "https://tickets.example/mcp",
  ]);
  assert.doesNotMatch(probed.join(" "), /SENTINEL|user|@|\?|#/);
  assert.ok(looked.includes("uvx") && looked.includes("gortex") && !looked.some(command => /SENTINEL/.test(command)));

  // Nothing secret reaches the client.
  assert.doesNotMatch(JSON.stringify(inventory), /SENTINEL/i);
});

test("unreadable configs are reported by position, and missing providers are marked not found", async () => {
  const { host } = fixtureHost({ env: { CODEX_HOME: join(home, "..", "broken-codex"), XDG_CONFIG_HOME: join(home, "..", "nowhere") } });
  const inventory = await collectToolsInventory(host);
  const codex = provider(inventory, "codex");
  assert.equal(codex.errors.length, 1);
  assert.match(codex.errors[0], /config\.toml: Invalid TOML at line 3, column 11/);
  assert.doesNotMatch(codex.errors[0], /SENTINEL/);
  assert.match(codex.notes[0], /command line wasn't found/);
  assert.deepEqual(codex.servers.map(item => item.name), []);
  const opencode = provider(inventory, "opencode");
  assert.equal(opencode.found, false);
  assert.deepEqual(opencode.servers, []);
});
