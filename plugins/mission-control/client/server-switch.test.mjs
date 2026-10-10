import assert from "node:assert/strict";
import { test } from "node:test";
import { isSwitchable, switchAnchor } from "./server-switch.ts";

const on = { enabled: true, file: "~/.codex/config.toml", key: "[mcp_servers.x] enabled", readOnly: null };
const servers = [
  { name: "chrome-devtools", toggle: on },
  { name: "gortex", toggle: on },
  { name: "cua_repl", toggle: { enabled: null, file: null, key: null, readOnly: "It comes from a Codex plugin." } },
  { name: "playwright", toggle: { ...on, enabled: false } },
];

test("a change's rows sit under the row that was clicked, for Turn off, Turn on and Undo", () => {
  assert.equal(switchAnchor("codex", servers, { provider: "codex", server: "playwright", enabled: true }), 3);
  assert.equal(switchAnchor("codex", servers, { provider: "codex", server: "gortex", enabled: false }), 1);
  assert.equal(switchAnchor("codex", servers, { provider: "codex", server: "gortex", enabled: null }), 1);
});

test("a server that is gone or read-only falls back to the top; another provider's change shows nowhere", () => {
  assert.equal(switchAnchor("codex", servers, { provider: "codex", server: "removed", enabled: false }), -1);
  assert.equal(switchAnchor("codex", servers, { provider: "codex", server: "cua_repl", enabled: false }), -1);
  assert.equal(switchAnchor("opencode", servers, { provider: "codex", server: "gortex", enabled: false }), null);
  assert.equal(switchAnchor("codex", servers, null), null);
});

test("a read-only row with the same name as a switchable one doesn't take its rows", () => {
  const twins = [{ name: "gortex", toggle: { enabled: null, file: null, key: null, readOnly: "From a plugin." } }, { name: "gortex", toggle: on }];
  assert.equal(switchAnchor("copilot", twins, { provider: "copilot", server: "gortex", enabled: false }), 1);
});

test("Claude Code and servers without a switch have no button", () => {
  assert.equal(isSwitchable("claude", { toggle: on }), false);
  assert.equal(isSwitchable("codex", { toggle: undefined }), false);
  assert.equal(isSwitchable("codex", servers[2]), false);
  assert.equal(isSwitchable("codex", servers[3]), true);
});
