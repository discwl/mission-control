import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url), ts = require("typescript");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const ref = { serverId: "srv_test", workspaceId: "wks_work", projectId: "prj_test", taskId: "task_abcdef01", runId: "run_abcdef02" };
const task = { schemaVersion: 1, taskId: ref.taskId, hostId: "personal", projectId: ref.projectId,
  title: "Restore original", acceptanceCriteria: "Keep evidence", status: "inbox", source: "manual",
  assignments: [{serverId: ref.serverId, workspaceId: "wks_source"}, {serverId: ref.serverId, workspaceId: ref.workspaceId}],
  worktree: {workspaceId:ref.workspaceId,sourceWorkspaceId:"wks_source",branch:"existing",baseCommit:"a".repeat(40),createdAt:"2026-10-01T00:00:00Z"},
  createdAt:"2026-10-01T00:00:00Z",updatedAt:"2026-10-01T00:01:00Z" };
const markdown = f => `---\r\n${Object.entries(f).map(([k,v]) => `${k}: ${JSON.stringify(v)}`).join("\r\n")}\r\n---\r\n\r\n# Original body\r\nPreserve every byte.\r\n`;
function modules(vault, overrides = {}) {
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const mod = {exports:{}}; cache.set(file,mod);
    const text = ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true,allowJs:true}}).outputText;
    const localRequire = name => {
      if (name === "@getpaseo/plugin") return {defineRpc: value=>value};
      if (name === "node:fs/promises") return {...fs,...overrides};
      if (name === "../shared/vault") return {defaultVaultPath:vault};
      if (!name.startsWith(".")) return require(name);
      const base=resolve(dirname(file),name), path=[base,`${base}.ts`,`${base}.mjs`].find(p=>existsSync(p));
      if (!path) throw new Error(`Unresolved fixture module ${name}`);
      return load(path);
    };
    new Function("require","module","exports",text)(localRequire,mod,mod.exports);
    return mod.exports;
  }
  return {server:load(join(root,"server/missing-task-recovery.ts")),shared:load(join(root,"shared/missing-task-recovery.ts"))};
}
async function fixture(t, overrides = {}, original = task) {
  const vault = await fs.mkdtemp(join(tmpdir(),"mc-missing-task-"));
  t.after(async()=>{assert.ok(vault.startsWith(`${resolve(tmpdir())}${sep}`));await fs.rm(vault,{recursive:true,force:true});});
  const targetRef = {...ref,taskId:original.taskId,projectId:original.projectId,serverId:original.assignments[0].serverId,workspaceId:original.worktree?.workspaceId??original.assignments[0].workspaceId};
  const folder=join(vault,"Tasks",targetRef.taskId), runFolder=join(folder,"runs",ref.runId), file=join(folder,"task.md");
  await fs.mkdir(join(runFolder,"decisions"),{recursive:true});await fs.mkdir(join(vault,"Projects"));
  await fs.writeFile(join(vault,"host.json"),JSON.stringify({schemaVersion:1,hostId:original.hostId,serverId:targetRef.serverId}));
  await fs.writeFile(join(vault,"Projects/project.md"),markdown({schemaVersion:1,hostId:original.hostId,projectId:original.projectId,repository:"C:/test"}));
  const run={schemaVersion:1,runId:ref.runId,taskId:original.taskId,hostId:original.hostId,projectId:original.projectId,serverId:targetRef.serverId,workspaceId:targetRef.workspaceId,
    agentId:"existing-agent",stage:"review",outcome:"waiting",createdAt:original.createdAt,updatedAt:original.updatedAt,nextAction:"Read review",gitHead:"a".repeat(40),gitDirty:true,gitChanges:[],omittedChanges:0};
  await fs.writeFile(join(runFolder,"run.md"),markdown(run));
  const decision={schemaVersion:1,decisionId:"decision_abcdef03",taskId:original.taskId,runId:ref.runId,serverId:targetRef.serverId,workspaceId:targetRef.workspaceId,agentId:"existing-agent",
    kind:"review",status:"open",question:"Accept?",requestedAt:original.updatedAt,gitHead:"a".repeat(40),gitDirty:true,evidence:[],findingIds:[],resolvedAt:null,note:null,resume:null,candidate:null,plain:null};
  const decisionFile=join(runFolder,"decisions/decision_abcdef03.md");await fs.writeFile(decisionFile,markdown(decision));
  const {server,shared}=modules(vault,overrides);
  const verify=async value=>value.assignments.map(a=>({...a,projectId:value.projectId,directory:"C:/test"}));
  const store=server.createMissingTaskRecovery(vault,verify);
  const backupContent=markdown(original),provenanceContent=JSON.stringify({source:"Authoritative fixture export",snapshots:6});
  const input={...targetRef,backupContent,expectedBackupRevision:hash(backupContent),provenanceContent,expectedProvenanceRevision:hash(provenanceContent)};
  const applyInput=async()=>({...input,expectedInspectionRevision:(await store.inspect(input)).inspectionRevision,confirmation:"restore-original-record",actor:"Global on behalf of actual user",reason:"Restore missing original record",authorizationEvidence:"Explicit scoped restore authorization receipt"});
  return {vault,folder,runFolder,file,run,decision,decisionFile,input,applyInput,store,server,shared,verify};
}
async function noTarget(f) { await assert.rejects(fs.lstat(f.file),{code:"ENOENT"}); }
function replaceBackup(input, content) { return {...input,backupContent:content,expectedBackupRevision:hash(content)}; }

test("restore exact bytes and original metadata with durable audit; no decision/run changes or prompts",async t=>{
  const f=await fixture(t), beforeDecision=await fs.readFile(f.decisionFile),beforeRun=await fs.readFile(join(f.runFolder,"run.md"));
  const inspected=await f.store.inspect(f.input);assert.equal(inspected.targetAbsent,true);await noTarget(f);
  const request=await f.applyInput(), result=await f.store.apply(request);assert.equal(result.applied,true);assert.deepEqual(result.warnings,[]);
  assert.equal(await fs.readFile(f.file,"utf8"),f.input.backupContent);assert.equal(result.revision,f.input.expectedBackupRevision);
  assert.equal(result.task.status,"inbox");assert.equal(result.task.updatedAt,task.updatedAt);
  const audit=join(f.vault,result.auditPath);assert.equal(await fs.readFile(join(audit,"original-task.md"),"utf8"),f.input.backupContent);
  assert.equal(JSON.parse(await fs.readFile(join(audit,"applied.json"),"utf8")).applied,true);
  assert.equal(JSON.parse(await fs.readFile(join(audit,"prepared.json"),"utf8")).actorAttribution,"caller-declared");
  assert.deepEqual(await fs.readFile(f.decisionFile),beforeDecision);assert.deepEqual(await fs.readFile(join(f.runFolder,"run.md")),beforeRun);
  await assert.rejects(f.store.apply(request),/already exists/);
});
for (const [name,edit] of [
  ["invalid status",f=>({...f,status:"done"})], ["unknown field",f=>({...f,unexpected:true})],
  ["unknown nested field",f=>({...f,assignments:[{...f.assignments[0],unexpected:true},f.assignments[1]]})],
  ["duplicate assignment",f=>({...f,assignments:[...f.assignments,f.assignments[0]]})],
  ["wrong task",f=>({...f,taskId:"task_ffff"})], ["wrong host",f=>({...f,hostId:"other"})],
  ["wrong project",f=>({...f,projectId:"other"})], ["foreign assignment",f=>({...f,assignments:[...f.assignments,{serverId:"other",workspaceId:"other"}]})],
  ["worktree drift",f=>({...f,worktree:{...f.worktree,workspaceId:"other"}})],
]) test(`refuses ${name}`,async t=>{const f=await fixture(t);await assert.rejects(f.store.inspect(replaceBackup(f.input,markdown(edit(task)))));await noTarget(f);});
test("rejects duplicate keys, bad hashes, non-JSON provenance and missing fields",async t=>{
 const f=await fixture(t);
 for(const input of [replaceBackup(f.input,f.input.backupContent.replace('source:', 'status: "ready"\r\nsource:')),{...f.input,expectedBackupRevision:"0".repeat(64)},{...f.input,expectedProvenanceRevision:"0".repeat(64)},{...f.input,provenanceContent:"[]",expectedProvenanceRevision:hash("[]")},replaceBackup(f.input,markdown({...task,title:undefined}))]) await assert.rejects(f.store.inspect(input));await noTarget(f);
});
for(const key of ["serverId","workspaceId","projectId","taskId","runId"]) test(`wrong selector ${key} refuses`,async t=>{const f=await fixture(t);await assert.rejects(f.store.inspect({...f.input,[key]:key==="taskId"?"task_ffff":key==="runId"?"run_ffff":"other"}));await noTarget(f);});
test("surviving run, decision and project identity mismatches refuse",async t=>{
 const f=await fixture(t);await fs.writeFile(join(f.runFolder,"run.md"),markdown({...f.run,taskId:"task_ffff"}));await assert.rejects(f.store.inspect(f.input),/run identity/);
 await fs.writeFile(join(f.runFolder,"run.md"),markdown(f.run));await fs.writeFile(f.decisionFile,markdown({...f.decision,workspaceId:"wrong"}));await assert.rejects(f.store.inspect(f.input),/decision identity/);
 await fs.writeFile(f.decisionFile,markdown(f.decision));await fs.copyFile(join(f.vault,"Projects/project.md"),join(f.vault,"Projects/duplicate.md"));await assert.rejects(f.store.inspect(f.input),/Exactly one/);await noTarget(f);
});
for(const phase of ["pending","sending"]) test(`pending delivery ${phase} refuses even with valid backup`,async t=>{
 const f=await fixture(t);await fs.writeFile(f.decisionFile,markdown({...f.decision,status:"approved",resume:{phase,error:null,updatedAt:task.updatedAt}}));await assert.rejects(f.store.inspect(f.input),/delivery/);await noTarget(f);
});
test("existing target or legacy record never overwritten",async t=>{
 const f=await fixture(t);await fs.writeFile(f.file,"do not overwrite");await assert.rejects(f.store.inspect(f.input),/already exists/);assert.equal(await fs.readFile(f.file,"utf8"),"do not overwrite");
 await fs.unlink(f.file);await fs.writeFile(join(f.vault,"Tasks",`${ref.taskId}.md`),"legacy");await assert.rejects(f.store.inspect(f.input),/already exists/);await noTarget(f);
});
test("hardlinked evidence and directory junction refuse",async t=>{
 const f=await fixture(t);await fs.link(f.decisionFile,join(f.folder,"linked.md"));await assert.rejects(f.store.inspect(f.input),/unlinked/);await fs.unlink(join(f.folder,"linked.md"));
 const other=join(f.vault,"other-runs");await fs.rename(join(f.folder,"runs"),other);await fs.symlink(other,join(f.folder,"runs"),"junction");await assert.rejects(f.store.inspect(f.input),/unlinked/);await noTarget(f);
});
test("stale inspection and active task/run locks never publish or steal lock",async t=>{
 const f=await fixture(t), input=await f.applyInput();await fs.writeFile(f.decisionFile,markdown({...f.decision,note:"changed"}));await assert.rejects(f.store.apply(input),/stale/);await noTarget(f);
 for(const file of [join(f.folder,".mission-control-write.lock"),join(f.runFolder,".write.lock")]){await fs.writeFile(file,"other-owner");await assert.rejects(f.store.apply(await f.applyInput()),/writer is active/);assert.equal(await fs.readFile(file,"utf8"),"other-owner");await fs.unlink(file);}await noTarget(f);
});
test("two simultaneous applies publish once",async t=>{const f=await fixture(t),input=await f.applyInput();const results=await Promise.allSettled([f.store.apply(input),f.store.apply(input)]);assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(await fs.readFile(f.file,"utf8"),input.backupContent);});
test("destination created just before atomic publication is never overwritten",async t=>{
 const f=await fixture(t,{link:async(from,to)=>{await fs.writeFile(to,"concurrent writer",{flag:"wx"});return fs.link(from,to);}});
 await assert.rejects(f.store.apply(await f.applyInput()),/Publication was attempted/);assert.equal(await fs.readFile(f.file,"utf8"),"concurrent writer");
});
test("link failure preserves backup and prepared receipt, target remains absent",async t=>{
 const f=await fixture(t,{link:async()=>{throw Object.assign(new Error("link refused"),{code:"EPERM"});}});await assert.rejects(f.store.apply(await f.applyInput()),/Publication was attempted/);await noTarget(f);
 const audit=(await fs.readdir(f.folder)).find(n=>n.startsWith(".mission-control-restore-"));assert.equal(await fs.readFile(join(f.folder,audit,"original-task.md"),"utf8"),f.input.backupContent);assert.equal(JSON.parse(await fs.readFile(join(f.folder,audit,"prepared.json"))).applied,false);
});
test("postpublication cleanup failure reports applied with warning",async t=>{
 const f=await fixture(t,{unlink:async path=>{if(path.endsWith(".mission-control-write.lock"))throw Object.assign(new Error("busy"),{code:"EBUSY"});return fs.unlink(path);}});
 const result=await f.store.apply(await f.applyInput());assert.equal(result.applied,true);assert.ok(result.warnings.some(w=>w.includes("Lock cleanup")));assert.equal(await fs.readFile(f.file,"utf8"),f.input.backupContent);
});
test("lock replacement during preparation is preserved and prevents publication",async t=>{
 let f, replaced=false;
 f=await fixture(t,{open:async(path,...args)=>{
   if(path.endsWith("candidate.tmp")&&!replaced){replaced=true;const lock=join(f.folder,".mission-control-write.lock");await fs.unlink(lock);await fs.writeFile(lock,"replacement-owner",{flag:"wx"});}
   return fs.open(path,...args);
 }});
 await assert.rejects(f.store.apply(await f.applyInput()),/ownership|owner|changed/i);await noTarget(f);
 assert.equal(await fs.readFile(join(f.folder,".mission-control-write.lock"),"utf8"),"replacement-owner");
});
test("evidence changed during preparation prevents publication",async t=>{
 let f, changed=false;
 f=await fixture(t,{open:async(path,...args)=>{
   if(path.endsWith("candidate.tmp")&&!changed){changed=true;await fs.writeFile(f.decisionFile,markdown({...f.decision,note:"concurrent update"}));}
   return fs.open(path,...args);
 }});
 await assert.rejects(f.store.apply(await f.applyInput()),/changed|stale/i);await noTarget(f);
});
test("final audit failure reports actual applied result and preserves prepared evidence",async t=>{
 const f=await fixture(t,{open:async(path,...args)=>{if(path.endsWith("applied.json"))throw Object.assign(new Error("audit disk error"),{code:"EIO"});return fs.open(path,...args);}});
 const result=await f.store.apply(await f.applyInput());assert.equal(result.applied,true);assert.ok(result.warnings.length>0);
 assert.equal(await fs.readFile(f.file,"utf8"),f.input.backupContent);assert.equal(JSON.parse(await fs.readFile(join(f.vault,result.auditPath,"prepared.json"))).applied,false);
});
test("missing surviving run and unavailable native identity refuse",async t=>{
 const f=await fixture(t);const store=f.server.createMissingTaskRecovery(f.vault,async()=>{throw new Error("native offline");});
 await assert.rejects(store.inspect(f.input),/native offline/);await fs.unlink(join(f.runFolder,"run.md"));await assert.rejects(f.store.inspect(f.input),/ENOENT/);await noTarget(f);
});
test("native identity changes invalidate inspection",async t=>{
 const f=await fixture(t);let version=0;const store=f.server.createMissingTaskRecovery(f.vault,async()=>({nativeVersion:version}));const input={...await f.applyInput(),expectedInspectionRevision:(await store.inspect(f.input)).inspectionRevision};version++;await assert.rejects(store.apply(input),/stale/);await noTarget(f);
});
test("public schemas reject arbitrary paths and require explicit authority; handlers use read-only native identity",async t=>{
 const f=await fixture(t), input=await f.applyInput();for(const bad of [{...input,actor:""},{...input,confirmation:"yes"},{...input,root:f.vault},{...input,expectedInspectionRevision:"bad"},{...input,authorizationEvidence:""}])assert.equal(f.shared.missingTaskApplyInput.safeParse(bad).success,false);
 const handlers=new Map();f.server.registerMissingTaskRecovery({handle:(rpc,fn)=>handlers.set(rpc.name,fn)});assert.deepEqual([...handlers.keys()],["tasks.missing-record.inspect","tasks.missing-record.apply"]);
 let calls=0;const paseo={workspaces:{ref:id=>({refresh:async()=>{calls++;return {id,projectId:ref.projectId,workspaceDirectory:"C:/test",archivingAt:null};}})}};
 const inspected=await handlers.get("tasks.missing-record.inspect")(f.input,{paseo});assert.equal(inspected.targetAbsent,true);assert.equal(calls,2);
 await assert.rejects(handlers.get("tasks.missing-record.inspect")(f.input,{paseo:{workspaces:{ref:id=>({refresh:async()=>({id,projectId:"wrong"})})}}}),/Native workspace/);await noTarget(f);
});
test("captured original WestCap snapshot restores verbatim only in isolated fixture",{skip:!process.env.MC_MISSING_TASK_BACKUP},async t=>{
 const backup=await fs.readFile(process.env.MC_MISSING_TASK_BACKUP,"utf8"), front=/^---\r?\n([\s\S]*?)\r?\n---/.exec(backup)[1];
 const original=Object.fromEntries(front.split(/\r?\n/).map(line=>{const i=line.indexOf(":");return [line.slice(0,i),JSON.parse(line.slice(i+1))];}));
 const f=await fixture(t,{},original);f.input.backupContent=backup;f.input.expectedBackupRevision=hash(backup);
 assert.equal(hash(backup),"cc5cda282e497b2f100245647565d99d47cd1ca584ee1d20e9051786460b19bb");
 const result=await f.store.apply(await f.applyInput());assert.equal(result.revision,hash(backup));assert.equal(await fs.readFile(f.file,"utf8"),backup);
});
