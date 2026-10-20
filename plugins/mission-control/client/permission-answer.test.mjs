import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { answerPermission, answerConfirmMs } = require("./permission-answer.ts");

const allow = { behavior: "allow" };
/** An agent whose request leaves its pending list after `resolvesAfter` reads (never, with Infinity). */
function agent({ resolvesAfter = 1, refresh } = {}) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    async respondToPermission(value) { calls.push(["respond", value]); },
    async refresh() {
      calls.push(["refresh"]);
      if (refresh) return refresh(++reads);
      return { agent: { pendingPermissions: ++reads < resolvesAfter ? [{ id: "request-1" }] : [] } };
    },
  };
}
const clock = () => { let time = 0; return { now: () => time, sleep: async ms => { time += ms; } }; };

test("an answer counts as done once Paseo no longer lists the request", async () => {
  const quick = agent();
  assert.equal(await answerPermission(quick, "request-1", allow, clock()), "confirmed");
  assert.deepEqual(quick.calls, [["respond", { requestId: "request-1", response: allow }], ["refresh"]]);
  const slow = agent({ resolvesAfter: 4 });
  assert.equal(await answerPermission(slow, "request-1", allow, clock()), "confirmed");
  assert.equal(slow.calls.filter(([name]) => name === "refresh").length, 4);
});

test("a request still pending after 15 seconds is reported, not shown as answered", async () => {
  const stuck = agent({ resolvesAfter: Infinity });
  const time = clock();
  assert.equal(await answerPermission(stuck, "request-1", allow, time), "pending");
  assert.equal(time.now(), answerConfirmMs);
});

test("a failed read proves nothing, and an agent that's gone has nothing waiting", async () => {
  const flaky = agent({ refresh: read => { if (read < 3) throw new Error("relay dropped"); return { agent: { pendingPermissions: [] } }; } });
  assert.equal(await answerPermission(flaky, "request-1", allow, clock()), "confirmed");
  const gone = agent({ refresh: () => null });
  assert.equal(await answerPermission(gone, "request-1", allow, clock()), "confirmed");
  const unreachable = agent({ refresh: () => { throw new Error("offline"); } });
  assert.equal(await answerPermission(unreachable, "request-1", allow, clock()), "pending");
});

test("another request still pending doesn't hold up this one", async () => {
  const other = agent({ refresh: () => ({ agent: { pendingPermissions: [{ id: "request-2" }] } }) });
  assert.equal(await answerPermission(other, "request-1", allow, clock()), "confirmed");
});
