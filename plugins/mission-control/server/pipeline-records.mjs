import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { checkpointSchema } from "../shared/pipeline-record-schema.mjs";
export { candidateSchema, checkpointSchema } from "../shared/pipeline-record-schema.mjs";
const inside = (root, path) => { const rel = relative(root, path); return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../"); };
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function evidenceFile(root, name) {
  const file = await realpath(resolve(root, name));
  const rel = relative(root, file).replaceAll("\\", "/");
  if (!inside(root, file) || rel.toLowerCase().startsWith("pipeline-checkpoints/") || rel.toLowerCase() === "run.md") throw new Error("Checkpoint evidence must be a report inside this exact run, outside its checkpoints.");
  const info = await stat(file);
  if (!info.isFile() || info.size < 1 || info.size > 5_000_000) throw new Error("Checkpoint evidence must be a nonempty file of at most 5 MB.");
  const bytes = await readFile(file);
  return { path: rel, sha256: digest(bytes), bytes: bytes.length };
}
export async function preparePipelineCheckpoint(runFolder, identity, input) {
  const root = await realpath(runFolder);
  if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 10) throw new Error("A checkpoint needs one to ten saved evidence files.");
  const evidence = await Promise.all(input.evidence.map(path => evidenceFile(root, path)));
  const checkpoint = checkpointSchema.parse({ ...input, ...identity, schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString(), evidence });
  if (checkpoint.stage === "review" && checkpoint.agentId === checkpoint.implementationAgentId) throw new Error("Independent review must be recorded by a different agent from the implementer.");
  return checkpoint;
}
export async function savePipelineCheckpoint(runFolder, prepared) {
  const root = await realpath(runFolder); const checkpoint = checkpointSchema.parse(prepared);
  for (const saved of checkpoint.evidence) { const current = await evidenceFile(root, saved.path); if (current.sha256 !== saved.sha256 || current.bytes !== saved.bytes) throw new Error("Evidence changed while recording the stage; no checkpoint was saved."); }
  const directory = join(root, "pipeline-checkpoints"); await mkdir(directory, { recursive: true });
  const actual = await realpath(directory); if (!inside(root, actual)) throw new Error("Checkpoint folder escapes its run.");
  await writeFile(join(actual, `${checkpoint.id}.json`), JSON.stringify(checkpoint, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return checkpoint;
}
export async function writePipelineCheckpoint(runFolder, identity, input) {
  return savePipelineCheckpoint(runFolder, await preparePipelineCheckpoint(runFolder, identity, input));
}
export async function readPipelineCheckpoints(runFolder, identity) {
  const root = await realpath(runFolder); const directory = join(root, "pipeline-checkpoints");
  let names; try { names = await readdir(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const actual = await realpath(directory); if (!inside(root, actual)) throw new Error("Checkpoint folder escapes its run.");
  if (names.length > 300) throw new Error("Too many pipeline checkpoints; inspect this run before continuing.");
  const result = [];
  for (const name of names) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new Error("Unrecognized checkpoint file.");
    const file = await realpath(join(actual, name)); if (!inside(actual, file) || (await stat(file)).size > 30_000) throw new Error("Invalid checkpoint file.");
    const entry = checkpointSchema.parse(JSON.parse(await readFile(file, "utf8")));
    if (name !== `${entry.id}.json` || Object.entries(identity).some(([key, value]) => entry[key] !== value)) throw new Error("Checkpoint belongs to another task, run, host or workspace.");
    if (entry.stage === "review" && entry.agentId === entry.implementationAgentId) throw new Error("Review checkpoint is not independent.");
    for (const saved of entry.evidence) { const current = await evidenceFile(root, saved.path); if (current.sha256 !== saved.sha256 || current.bytes !== saved.bytes) throw new Error("Checkpoint evidence changed; record a fresh report before continuing."); }
    result.push(entry);
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
