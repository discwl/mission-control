import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { assignmentSchema, readStageAssignments } from "../plugins/mission-control/server/stage-records.mjs";
import { readAutomaticPlan } from "../plugins/mission-control/server/plan-snapshots.mjs";
import { readPipelineCheckpoints } from "../plugins/mission-control/server/pipeline-records.mjs";
import { readActionBundle, readActionAuthorization, saveActionAuthorization } from "../plugins/mission-control/server/action-bundles.mjs";
import { planBrief } from "../plugins/mission-control/server/plan-test-data.mjs";

const cli = join(dirname(fileURLToPath(import.meta.url)), "dev-flow.mjs");
const require = createRequire(new URL("../plugins/mission-control/package.json", import.meta.url));
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { resolveRolePolicy } = require("./shared/agent-policy.ts");
const { nextPipelineStep, missingReviewRole } = require("./shared/pipeline-model.ts");
const recordText = fields => `---\n${Object.entries(fields).map(([key,value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n`;
const parseRecord = text => Object.fromEntries(text.split("\n---\n")[0].split("\n").filter(line => /^[A-Za-z]/.test(line) && line.includes(": ")).map(line => { const at=line.indexOf(": "); return [line.slice(0,at),JSON.parse(line.slice(at+2))]; }));

async function fixture(t, deliveryKind = "code") {
  const root = await mkdtemp(join(tmpdir(), "dev-flow-auto-"));
  t.after(async () => { const resolved=await realpath(root), segment=relative(await realpath(tmpdir()),resolved); if (!segment.startsWith("dev-flow-auto-") || segment.includes("..") || isAbsolute(segment)) throw Error("Unsafe fixture cleanup"); await rm(resolved,{recursive:true,force:true}); });
  const vault=join(root,"vault"), repo=join(root,"repo"), taskId=`task_${randomUUID()}`, serverId="srv_test", workspaceId="wks_test", projectId="prj_test";
  const folder=join(vault,"Tasks",taskId); await mkdir(folder,{recursive:true}); await mkdir(join(vault,"Projects")); await mkdir(repo);
  execFileSync("git",["init","-q",repo]); await writeFile(join(repo,"work.js"),"export const enabled = true;\n");
  const task={schemaVersion:1,taskId,hostId:"test",projectId,title:"Prevent duplicate submissions",acceptanceCriteria:"Preserve existing orders and test duplicate submissions.",status:"ready",source:"manual",assignments:[{serverId,workspaceId}],createdAt:"2026-01-01T00:00:00Z",updatedAt:"2026-01-01T00:00:00Z"};
  await writeFile(join(vault,"host.json"),JSON.stringify({schemaVersion:1,hostId:"test",serverId}));
  await writeFile(join(vault,"Projects","test.md"),recordText({schemaVersion:1,hostId:"test",projectId,repository:repo,kitRoot:dirname(dirname(cli))}));
  await writeFile(join(folder,"task.md"),recordText(task)); await writeFile(join(folder,"plan.md"),"# Plan\nPreserve existing orders and check duplicate submissions.\n");
  const profiles=[{id:"planner",name:"Planner",provider:"claude",model:"fable"},{id:"builder",name:"Builder",provider:"codex",model:"sol"},{id:"validator",name:"Validator",provider:"claude",model:"sonnet"},{id:"reviewer",name:"Reviewer A",provider:"claude",model:"opus"},{id:"reviewer2",name:"Reviewer B",provider:"codex",model:"astra"}];
  const policy=resolveRolePolicy([{projectId:null,taskId:null,updatedAt:"2026-01-01T00:00:00Z",mapping:{planner:"planner",builder:"builder",validator:"validator",reviewer:"reviewer",reviewer2:"reviewer2",reviewCount:2}}],profiles,projectId,taskId,"automatic");
  const nativePath=join(root,"native-fixture.json"), nativeLog=join(root,"native-calls.jsonl"), loader=join(root,"native-loader.mjs");
  const native={agents:{},policyRevision:policy.revision,projectId};
  await writeFile(nativePath,JSON.stringify(native));
  const nativeSource=`import assert from 'node:assert/strict'; import {readFile,appendFile} from 'node:fs/promises'; export async function verifyNativeStageAgent(assignment,options={}) { const fixture=JSON.parse(await readFile(${JSON.stringify(nativePath)},'utf8')); const actual=fixture.agents[assignment.agentId]; assert.ok(actual,'Unknown native fixture agent'); assert.equal(assignment.workspaceId,actual.workspaceId); assert.equal(assignment.execution.provider,actual.provider); assert.equal(assignment.execution.model,actual.model); if(options.projectId){assert.equal(options.projectId,fixture.projectId);assert.equal(options.workflowMode,'automatic');} await appendFile(${JSON.stringify(nativeLog)},JSON.stringify({agentId:assignment.agentId,stage:assignment.stage,options})+'\\n');return {provider:actual.provider,model:actual.model,verifiedAt:new Date().toISOString(),...(options.projectId?{policyRevision:fixture.policyRevision}:{})};}`;
  await writeFile(loader,`export async function load(url,context,nextLoad){if(url.endsWith('/native-stage-identity.mjs'))return{format:'module',shortCircuit:true,source:${JSON.stringify(nativeSource)}};return nextLoad(url,context);}`);
  const invoke=(command,extras=[])=>spawnSync(process.execPath,["--experimental-loader",pathToFileURL(loader).href,cli,command,"--task",taskId,"--server",serverId,"--workspace",workspaceId,...extras],{cwd:repo,env:{...process.env,PASEO_AGENT_ID:"",DEV_VAULT_ROOT:vault,NODE_NO_WARNINGS:"1"},encoding:"utf8"});
  const started=invoke("start",["--agent","agent-planner"]); assert.equal(started.status,0,started.stderr); const runId=JSON.parse(started.stdout).run.runId, runFolder=join(folder,"runs",runId), identity={taskId,runId,serverId,workspaceId};
  const args={taskFolder:folder,runFolder,task,identity};
  async function command(command,agentId,input){const inputPath=join(root,`input-${randomUUID()}.json`);await writeFile(inputPath,JSON.stringify(input));return invoke(command,["--run",runId,"--agent",agentId,"--input",inputPath]);}
  async function assign(role,stage,{candidate=null,planRevision=null,scopeRevision=null}={}) {
    const profile=policy.profiles.find(item=>item.role===role);assert.ok(profile,role);const id=randomUUID(),agentId=`agent-${id}`;
    const assignment=assignmentSchema.parse({id,...identity,agentId,stage,workflowMode:"automatic",deliveryKind,planRevision,planScopeRevision:scopeRevision,candidate,createdAt:new Date().toISOString(),reviewCount:2,manifest:stage==="review"&&deliveryKind==="code"?`ocr-${id}.json`:null,execution:{assignmentId:id,policyRevision:policy.revision,role,profileId:profile.id,profileName:profile.name,provider:profile.provider,model:profile.model}});
    await mkdir(join(runFolder,"stage-assignments"),{recursive:true});await writeFile(join(runFolder,"stage-assignments",`${id}.json`),JSON.stringify(assignment));
    if(assignment.manifest)await writeFile(join(runFolder,assignment.manifest),JSON.stringify({assignmentId:id,candidate,files:[{path:"work.js",status:"A"}],excluded:[]}));
    native.agents[agentId]={workspaceId,provider:profile.provider,model:profile.model};await writeFile(nativePath,JSON.stringify(native));return assignment;
  }
  async function submit(){const planner=await assign("planner","plan");const result=await command("submit-plan",planner.agentId,{planBrief});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout).plan;}
  async function checkpoint(assigned,verdict="pass",scope="approved",findings=[]) {const report=`report-${randomUUID()}.md`;await writeFile(join(runFolder,report),`# Actual checkpoint\n${verdict}: ${assigned.stage}\n`);const result=await command("checkpoint",assigned.agentId,{stage:assigned.stage,verdict,scope,summary:`${assigned.stage} ${verdict}`,evidence:[report],findings,...(assigned.manifest?{coverage:[{path:"work.js",status:"A",outcome:"reviewed",reason:""}]}:{})});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout).checkpoint;}
  const currentRun=async()=>parseRecord(await readFile(join(runFolder,"run.md"),"utf8"));
  async function facts(){return{workflowMode:"automatic",deliveryKind,entry:{task,run:await currentRun(),decisions:[],questions:[]},agentPolicy:policy,submittedPlan:await readAutomaticPlan({...args,policyRevision:policy.revision}),planRevision:(await readAutomaticPlan(args))?.revision??null,candidate:(await readPipelineCheckpoints(runFolder,identity)).find(item=>item.stage!=="plan-review")?.candidate??null,checkpoints:await readPipelineCheckpoints(runFolder,identity),assignments:await readStageAssignments(runFolder,identity),problem:null};}
  const row={taskId,workflowMode:"automatic",deliveryKind,mode:"active",stage:"plan",repairs:0,repairIds:[],planRepairs:0,planRepairIds:[]};
  async function acceptedPlan(){const plan=await submit();const critic=await assign("planReviewer","plan-review",{planRevision:plan.revision,scopeRevision:plan.scopeRevision,candidate:{head:null,tree:plan.revision}});await checkpoint(critic);return plan;}
  return{root,vault,repo,folder,runFolder,identity,args,task,policy,native,nativePath,nativeLog,command,assign,submit,checkpoint,currentRun,facts,row,acceptedPlan};
}

test("action completion rejects an authorized bundle from a superseded accepted plan before writing an event", async t => {
  const f = await fixture(t, "actions");
  const plan = await f.acceptedPlan();
  const builder = await f.assign("builder", "execute", { planRevision: plan.revision, scopeRevision: plan.scopeRevision });
  const saved = await f.command("save-actions", builder.agentId, { kind: "actions", summary: "Inspect duplicate orders", environment: "test", prerequisites: [], steps: [{ instruction: "Read duplicate order counts", effect: "Record the duplicate count without changing orders" }], verification: ["Save the observed count"], rollback: "Read-only inspection; no rollback is required." });
  assert.equal(saved.status, 0, saved.stderr);
  const bundle = JSON.parse(saved.stdout).bundle;
  await saveActionAuthorization(f.args, { revision: bundle.revision, fingerprint: "a".repeat(64), planRevision: plan.revision, policyRevision: f.policy.revision, actorId: "human-test", authorizedAt: new Date().toISOString(), agentId: builder.agentId, resumeState: "sent" });
  await writeFile(join(f.runFolder, "execution.md"), "Observed zero duplicate orders in the test environment.\n");
  await writeFile(join(f.folder, "plan.md"), "# Revised plan\nInspect duplicate orders and verify the report includes the inspected environment.\n");
  const planner = await f.assign("planner", "plan");
  const submitted = await f.command("submit-plan", planner.agentId, { planBrief: { ...planBrief, changesSincePrevious: ["Also identify the inspected environment in the report."] } });
  assert.equal(submitted.status, 0, submitted.stderr);
  const updated = JSON.parse(submitted.stdout).plan;
  const critic = await f.assign("planReviewer", "plan-review", { planRevision: updated.revision, scopeRevision: updated.scopeRevision, candidate: { head: null, tree: updated.revision } });
  await f.checkpoint(critic);
  assert.notEqual(updated.revision, plan.revision);
  const before = await readFile(join(f.runFolder, "run.md"), "utf8");
  const events = await readdir(join(f.runFolder, "events"));
  const rejected = await f.command("record", builder.agentId, { stage: "delivery", outcome: "completed", summary: "Inspected duplicate orders", nextAction: "Delivery complete", evidence: ["execution.md"], actionRevision: bundle.revision });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /outdated plan/);
  assert.equal(await readFile(join(f.runFolder, "run.md"), "utf8"), before);
  assert.deepEqual(await readdir(join(f.runFolder, "events")), events);
  assert.equal((await readActionAuthorization(f.args)).resumeState, "sent");
});

test("persisted automatic repair checkpoints continue plan repair, Review B and fixes; genuine blockers stop", async t=>{
 const f=await fixture(t);let plan=await f.submit();
 const critic=await f.assign("planReviewer","plan-review",{planRevision:plan.revision,scopeRevision:plan.scopeRevision,candidate:{head:null,tree:plan.revision}});
 const findings=[{title:"Missing duplicate-submit check",severity:"medium",detail:"Add a concrete check for repeated submission while the request is pending.",file:"work.js"}];
 await f.checkpoint(critic,"repair","approved",findings);assert.equal((await f.currentRun()).outcome,"in_progress");assert.equal(nextPipelineStep(f.row,await f.facts()).stage,"plan");
 plan=await f.acceptedPlan();const builder=await f.assign("builder","execute",{planRevision:plan.revision});const built=await f.checkpoint(builder);
 const validator=await f.assign("validator","validate",{planRevision:plan.revision,candidate:built.candidate});await f.checkpoint(validator);
 const reviewer=await f.assign("reviewer","review",{planRevision:plan.revision,candidate:built.candidate});await f.checkpoint(reviewer,"repair","approved",findings);
 let facts=await f.facts();assert.equal(facts.entry.run.outcome,"in_progress");assert.equal(nextPipelineStep(f.row,facts).stage,"review");assert.equal(missingReviewRole(facts),"reviewer2");
 const reviewer2=await f.assign("reviewer2","review",{planRevision:plan.revision,candidate:built.candidate});await f.checkpoint(reviewer2);
 assert.equal(nextPipelineStep(f.row,await f.facts()).stage,"fix");
 const blocked=await f.assign("validator","validate",{planRevision:plan.revision,candidate:built.candidate});await f.checkpoint(blocked,"blocked","approved");assert.equal((await f.currentRun()).outcome,"blocked");assert.equal(nextPipelineStep(f.row,await f.facts()).mode,"blocked");
 const expanded=await f.assign("reviewer","review",{planRevision:plan.revision,candidate:built.candidate});await f.checkpoint(expanded,"repair","needs_plan",findings);assert.equal((await f.currentRun()).outcome,"blocked");assert.equal(nextPipelineStep(f.row,await f.facts()).mode,"blocked");
});

test("save-actions succeeds with a parsed nested-role assignment and rejected completion never writes a completed event", async t=>{
 const f=await fixture(t,"actions"),plan=await f.acceptedPlan(),builder=await f.assign("builder","execute",{planRevision:plan.revision});
 const bundleInput={kind:"actions",summary:"Prepared staging view update",environment:"staging",prerequisites:["Verify staging target"],steps:[{instruction:"Apply the reviewed staging script",effect:"Change the staging view only"}],verification:["Compare the view definition"],rollback:"Restore the saved definition"};
 const saved=await f.command("save-actions",builder.agentId,bundleInput);assert.equal(saved.status,0,saved.stderr);
 const bundle=await readActionBundle({...f.args,planRevision:plan.revision});assert.ok(bundle);assert.equal(bundle.bundle.steps[0].instruction,bundleInput.steps[0].instruction);
 const nativeCalls=(await readFile(f.nativeLog,"utf8")).trim().split("\n").map(JSON.parse);assert.ok(nativeCalls.some(call=>call.agentId===builder.agentId&&call.stage==="execute"));
 await saveActionAuthorization(f.args,{revision:bundle.revision,fingerprint:"a".repeat(64),planRevision:plan.revision,policyRevision:f.policy.revision,actorId:"human-test",authorizedAt:new Date().toISOString(),agentId:builder.agentId,resumeState:"uncertain"});
 const report="actual-execution.md";await writeFile(join(f.runFolder,report),"# Actual execution\nApplied the approved staging script and verified the resulting view.\n");
 const completion={stage:"delivery",outcome:"completed",summary:"Applied and verified the approved staging steps.",nextAction:"No remaining work.",actionRevision:bundle.revision,evidence:[report]};
 const before=await readFile(join(f.runFolder,"run.md"),"utf8"),eventsBefore=await readdir(join(f.runFolder,"events"));
 for(const change of [{actionRevision:"b".repeat(64)},{evidence:["missing-report.md"]},{nextAction:""}]){const result=await f.command("record",builder.agentId,{...completion,...change});assert.notEqual(result.status,0);assert.equal(await readFile(join(f.runFolder,"run.md"),"utf8"),before);assert.deepEqual(await readdir(join(f.runFolder,"events")),eventsBefore);}
 f.native.policyRevision="changed-policy";await writeFile(f.nativePath,JSON.stringify(f.native));const stale=await f.command("record",builder.agentId,completion);assert.notEqual(stale.status,0);assert.match(stale.stderr,/policy changed/);assert.equal(await readFile(join(f.runFolder,"run.md"),"utf8"),before);
 f.native.policyRevision=f.policy.revision;await writeFile(f.nativePath,JSON.stringify(f.native));
 const eventsPath=join(f.runFolder,"events"),savedEvents=join(f.runFolder,"events-saved");assert.ok(relative(f.root,eventsPath).startsWith("vault"));assert.ok(relative(f.root,savedEvents).startsWith("vault"));
 await rename(eventsPath,savedEvents);await writeFile(eventsPath,"Prevent event output for this fixture only");
 const interrupted=await f.command("record",builder.agentId,completion);assert.notEqual(interrupted.status,0);assert.equal(await readFile(join(f.runFolder,"run.md"),"utf8"),before);assert.equal((await readActionAuthorization(f.args)).resumeState,"completed");
 await unlink(eventsPath);await rename(savedEvents,eventsPath);
 const complete=await f.command("record",builder.agentId,completion);assert.equal(complete.status,0,complete.stderr);assert.equal((await f.currentRun()).outcome,"completed");assert.equal((await readActionAuthorization(f.args)).resumeState,"completed");
 const retry=await f.command("record",builder.agentId,completion);assert.equal(retry.status,0,retry.stderr);assert.equal((await readActionAuthorization(f.args)).resumeState,"completed");
});
