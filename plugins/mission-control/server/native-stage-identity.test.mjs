import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(new URL("./native-stage-identity.mjs", import.meta.url), "utf8");
const body = source.slice(source.indexOf("export async function verifyNativeStageAgent")).replace("export async function", "async function");
function fixture({ problem, policyRevision = "current-policy", actualModel = "astra" } = {}) {
  const calls = []; let closed = false, disposed = false;
  const assignment = { serverId: "server", workspaceId: "workspace", taskId: "task", agentId: "builder", execution: { provider: "codex", model: "astra" } };
  const client = { connect: async () => {}, getLastServerInfoMessage: () => ({serverId:"server"}), invokePluginRpc: async (...args) => { calls.push(args); return {problem,effective:policyRevision?{revision:policyRevision}:null}; }, close: async () => { closed=true; } };
  const verify = vm.runInNewContext(body + "\nverifyNativeStageAgent", { process:{env:{}}, join, homedir:()=>"home", randomUUID:()=>"fixture", readFile:async()=>JSON.stringify({serverId:"server",listen:"127.0.0.1:6767"}), createHostClient:()=>client, createPaseoApi:()=>({agents:{ref:()=>({refresh:async()=>({agent:{workspaceId:"workspace",provider:"codex",model:actualModel}})})},dispose:()=>{disposed=true;}}) });
  return {assignment,verify,calls,closed:()=>closed,disposed:()=>disposed};
}
test("native completion verification reads the current task's automatic policy from the already verified host", async()=>{
 const f=fixture();const result=await f.verify(f.assignment,{projectId:"project",workflowMode:"automatic"});
 assert.equal(result.policyRevision,"current-policy");assert.equal(result.model,"astra");
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls)),[["mission-control","workflow.agents.read",{serverId:"server",projectId:"project",taskId:"task",workflowMode:"automatic"}]]);
 assert.equal(f.closed(),true);assert.equal(f.disposed(),true);
});
test("ordinary stage checks preserve the original identity-only contract",async()=>{
 const f=fixture();const result=await f.verify(f.assignment);assert.equal(result.policyRevision,undefined);assert.equal(f.calls.length,0);assert.equal(f.closed(),true);
});
test("unavailable policy and mismatched native models cannot establish completion authority",async()=>{
 for(const settings of [{problem:"Missing reviewer"},{policyRevision:null},{actualModel:"another-model"}]){const f=fixture(settings);await assert.rejects(f.verify(f.assignment,{projectId:"project",workflowMode:"automatic"}),/policy|actual provider\/model/);assert.equal(f.closed(),true);assert.equal(f.disposed(),true);}
});
