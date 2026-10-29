import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { candidateSchema } from "../shared/pipeline-record-schema.mjs";
import { executionSchema, coverageSchema, reviewFindingSchema, verifyCoverage } from "../shared/stage-evidence.mjs";
import { verifyNativeStageAgent } from "./native-stage-identity.mjs";

export const assignmentSchema = z.object({
  id: z.string().uuid(), taskId: z.string(), runId: z.string(), serverId: z.string(), workspaceId: z.string(), agentId: z.string(),
  stage: z.enum(["plan", "execute", "fix", "validate", "review"]), execution: executionSchema,
  planRevision: z.string().nullable(), candidate: candidateSchema.nullable(), createdAt: z.string(),
  reviewCount: z.union([z.literal(1), z.literal(2)]), manifest: z.string().nullable(),
  requestId: z.string().optional(),
});
export async function readStageJson(root, name) {
  const base = await realpath(root); const file = await realpath(join(base, name)); const rel = relative(base, file);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith("..\\") || rel.startsWith("../") || (await stat(file)).size > 5_000_000) throw new Error("Invalid stage evidence path.");
  return JSON.parse(await readFile(file, "utf8"));
}
export async function readStageAssignments(folder, identity) {
  let names;
  try { names = await readdir(join(folder, "stage-assignments")); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (names.length > 300) throw new Error("Too many stage assignments. Inspect this run.");
  const rows = [];
  for (const name of names) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new Error("Invalid stage assignment filename.");
    const row = assignmentSchema.parse(await readStageJson(folder, `stage-assignments/${name}`));
    if (name !== `${row.id}.json` || row.execution.assignmentId !== row.id || Object.entries(identity).some(([key, value]) => row[key] !== value)) throw new Error("Stage assignment identity mismatch.");
    rows.push(row);
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function checkpointStageEvidence(folder, identity, input, { verifyAgent = verifyNativeStageAgent } = {}) {
  const assignments = await readStageAssignments(folder, { taskId: identity.taskId, runId: identity.runId, serverId: identity.serverId, workspaceId: identity.workspaceId });
  if (!assignments.length) return { ...input, execution: undefined, ocr: undefined }; // Preserve legacy runs without claiming new verification.
  const assigned = assignments.find(item => item.agentId === identity.agentId && item.stage === input.stage);
  if (!assigned || assigned.planRevision !== input.planRevision) throw new Error("This agent has no assignment for this stage and approved plan.");
  await verifyAgent(assigned);
  if (["validate", "review"].includes(input.stage) && JSON.stringify(assigned.candidate) !== JSON.stringify(identity.candidate)) throw new Error("Code changed since this stage was assigned. Start a fresh stage.");
  const evidence = [...input.evidence, `stage-assignments/${assigned.id}.json`];
  let ocr;
  if (input.stage === "review") {
    if (!assigned.manifest) throw new Error("OCR execution evidence is missing.");
    const manifest = await readStageJson(folder, assigned.manifest);
    if (manifest.assignmentId !== assigned.id || JSON.stringify(manifest.candidate) !== JSON.stringify(identity.candidate)) throw new Error("OCR manifest belongs to a different review.");
    const coverage = coverageSchema.parse(input.coverage);
    verifyCoverage(manifest.files, coverage, input.verdict === "pass");
    const findings = z.array(reviewFindingSchema).max(50).parse(input.findings ?? []);
    if (findings.length && input.verdict === "pass") throw new Error("Record repair or blocked when the review has findings; do not silently discard them.");
    ocr = { manifest: assigned.manifest, coverage, excluded: manifest.excluded.length, findings };
    evidence.push(assigned.manifest);
  }
  return { ...input, evidence, execution: assigned.execution, ocr };
}
