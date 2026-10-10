import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { effectiveWorkflowInstructions, emptyHostInstructions, emptyProjectInstructions, workflowInstructionProblem } from "../shared/workflow-instructions.mjs";

const projectIdPattern = /^[A-Za-z0-9_-]{1,120}$/;
const markers = { intake: "<!-- mission-control:intake -->", planning: "<!-- mission-control:planning -->" };
const inside = (root, path) => { const rest = relative(root, path); return !isAbsolute(rest) && rest !== ".." && !rest.startsWith("../") && !rest.startsWith("..\\"); };
const missing = error => error?.code === "ENOENT";

/** Also used by dev-flow context, so CLI and plugin consume exactly the same vault notes. */
export function createWorkflowInstructionsStore(vaultRoot) {
  async function identity(input) {
    if (input.projectId !== null && (!projectIdPattern.test(input.projectId ?? "") || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(input.projectId ?? ""))) throw new Error("Invalid workflow instructions project ID.");
    const root = await realpath(vaultRoot);
    const file = join(root, "host.json");
    if (!(await lstat(file)).isFile()) throw new Error("The vault host profile must be a regular file.");
    const markdown = await readFile(file, "utf8");
    const host = JSON.parse(markdown);
    if (host.schemaVersion !== 1 || typeof host.hostId !== "string" || !host.hostId || host.serverId !== input.serverId || (input.hostId !== undefined && host.hostId !== input.hostId)) {
      throw new Error("Workflow instructions belong to another host. Open this host's Mission Control settings.");
    }
    return { root, hostId: host.hostId, serverId: host.serverId, markdown };
  }
  async function folder(root, parts, create = false) {
    let path = root;
    for (const part of parts) {
      path = join(path, part);
      let stat;
      try { stat = await lstat(path); }
      catch (error) {
        if (!missing(error)) throw error;
        if (!create) return null;
        try { await mkdir(path); } catch (error) { if (error.code !== "EEXIST") throw error; }
        stat = await lstat(path);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(root, await realpath(path))) throw new Error("Workflow instruction folders must stay inside the vault and cannot be links.");
    }
    return path;
  }
  async function note(root, projectId, host) {
    const parts = projectId === null ? ["Workflow"] : ["Workflow", "Projects"];
    const parent = await folder(root, parts);
    const name = projectId === null ? "host.md" : `${projectId}.md`;
    const file = join(root, ...parts, name);
    const fallback = projectId === null ? emptyHostInstructions() : emptyProjectInstructions();
    if (!parent) return { file, text: null, values: fallback };
    let stat;
    try { stat = await lstat(file); } catch (error) { if (missing(error)) return { file, text: null, values: fallback }; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000) throw new Error(`Workflow instructions must be a regular note under 100 KB: ${file}`);
    const text = await readFile(file, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    if (!frontmatter) throw new Error(`Workflow instructions have invalid frontmatter: ${file}`);
    const fields = Object.create(null);
    for (const line of frontmatter[1].split(/\r?\n/)) {
      const at = line.indexOf(":");
      const key = line.slice(0, at);
      if (at < 1 || Object.hasOwn(fields, key)) throw new Error(`Workflow instructions have invalid or duplicate fields: ${file}`);
      fields[key] = JSON.parse(line.slice(at + 1).trim());
    }
    if (fields.schemaVersion !== 1 || fields.hostId !== host.hostId || fields.serverId !== host.serverId || fields.projectId !== projectId) throw new Error(`Workflow instruction note belongs to a different host or project: ${file}`);
    const body = text.slice(frontmatter[0].length);
    const pieces = body.split(/<!-- mission-control:(intake|planning) -->\r?\n/);
    if (pieces.length !== 5 || pieces[1] !== "intake" || pieces[3] !== "planning") throw new Error(`Workflow instruction sections are missing or duplicated: ${file}`);
    const values = { intake: pieces[2].replace(/\r?\n\r?\n## Planning guidance\r?\n\r?\n$/, "").trim(), planning: pieces[4].trim() };
    if (projectId !== null) Object.assign(values, { intakeMode: fields.intakeMode, planningMode: fields.planningMode });
    const problem = workflowInstructionProblem(values, projectId !== null);
    if (problem) throw new Error(`${file}: ${problem}`);
    return { file, text, values };
  }
  async function read(input) {
    const host = await identity(input);
    const defaults = await note(host.root, null, host);
    const project = input.projectId === null ? null : await note(host.root, input.projectId, host);
    const values = project?.values ?? emptyProjectInstructions();
    return {
      hostId: host.hostId, serverId: host.serverId, projectId: input.projectId,
      host: defaults.values, project: values, effective: effectiveWorkflowInstructions(defaults.values, values),
      revision: createHash("sha256").update(JSON.stringify([host.markdown, defaults.text, project?.text ?? null, input.projectId])).digest("hex"),
      paths: { host: defaults.file, project: project?.file ?? null },
    };
  }
  async function save(input) {
    const problem = workflowInstructionProblem(input.values, input.projectId !== null);
    if (problem) throw new Error(problem);
    const host = await identity(input);
    const directory = await folder(host.root, ["Workflow"], true);
    const lockPath = join(directory, ".instructions-write.lock");
    let lock;
    try { lock = await open(lockPath, "wx"); }
    catch (error) { if (error.code === "EEXIST") throw new Error("Workflow instructions are being saved. Reload and retry."); throw error; }
    let temporary;
    try {
      const current = await read(input);
      if (current.revision !== input.expectedRevision) throw new Error("Workflow instructions changed while you were editing. Discard changes, reload and try again.");
      const parent = input.projectId === null ? directory : await folder(host.root, ["Workflow", "Projects"], true);
      const file = input.projectId === null ? current.paths.host : current.paths.project;
      const fields = { schemaVersion: 1, hostId: host.hostId, serverId: host.serverId, projectId: input.projectId,
        ...(input.projectId === null ? {} : { intakeMode: input.values.intakeMode, planningMode: input.values.planningMode }) };
      const text = `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n# Workflow instructions\n\n## Intake guidance\n\n${markers.intake}\n${input.values.intake.trim()}\n\n## Planning guidance\n\n${markers.planning}\n${input.values.planning.trim()}\n`;
      temporary = join(parent, `.instructions-${randomUUID()}.tmp`);
      await writeFile(temporary, text, { flag: "wx" });
      // Check identity and optimistic revision again before replacing the selected note.
      if ((await read(input)).revision !== input.expectedRevision) throw new Error("Workflow instructions changed during saving. Reload and retry.");
      await rename(temporary, file);
      temporary = null;
      return await read(input);
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      await lock.close();
      await unlink(lockPath);
    }
  }
  return { read, save };
}
