export type DocumentLink = { target: string; label: string; relative: boolean };
const taskPattern = /^task_[a-f0-9-]+$/i;
export function documentLabel(target: string, alias?: string): string {
  if (alias?.trim()) return alias.trim().toLowerCase() === "handoff" ? "View handoff" : alias.trim();
  const name = target.replaceAll("\\", "/").split("/").pop()?.replace(/\.md(?:#.*)?$/i, "").split("#")[0] ?? "";
  if (taskPattern.test(name) || name === "task") return "Task details";
  if (/^(run|event)_[a-f0-9-]+$/i.test(name)) return name.startsWith("run_") ? "Run record" : "Activity update";
  if (name === "handoff") return "View handoff";
  return name.replaceAll("_", " ") || "Document";
}
export function wikiLink(value: string): DocumentLink | null {
  const match = /^\[\[([^\]]+)\]\]$/.exec(value);
  if (!match) return null;
  const separator = match[1].indexOf("|");
  const target = (separator < 0 ? match[1] : match[1].slice(0, separator)).trim();
  return { target, label: documentLabel(target, separator < 0 ? undefined : match[1].slice(separator + 1)), relative: false };
}
export function isDocumentTarget(value: string): boolean { return !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value); }
function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) throw new Error("That document link leaves the vault."); parts.pop(); }
    else { if (part.includes(":")) throw new Error("That document link is not a vault path."); parts.push(part); }
  }
  return parts.join("/");
}
export function documentCandidates(target: string, sourcePath = "", relative = false, root = ""): string[] {
  let path: string;
  try { path = decodeURIComponent(target).replaceAll("\\", "/").split("#")[0].trim(); } catch { throw new Error("That document link has invalid encoding."); }
  if (!path) throw new Error("That document link has no file target.");
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(path)) {
    const prefix = root.replaceAll("\\", "/").replace(/\/$/, "") + "/";
    if (!root || !path.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error("That document link is outside this vault.");
    path = path.slice(prefix.length);
  }
  const note = /\.[a-z0-9]+$/i.test(path) ? path : `${path}.md`;
  let source = sourcePath.replaceAll("\\", "/");
  const prefix = root.replaceAll("\\", "/").replace(/\/$/, "") + "/";
  if (root && source.toLowerCase().startsWith(prefix.toLowerCase())) source = source.slice(prefix.length);
  const parent = source.split("/").slice(0, -1).join("/");
  if (relative || /^\.{1,2}\//.test(path)) return [normalize(`${parent ? `${parent}/` : ""}${note}`)];
  if (path.includes("/")) return [normalize(note)];
  return [...new Set([normalize(`${parent ? `${parent}/` : ""}${note}`), normalize(note)])];
}
type Entry = { path: string; kind: string };
type Dependencies = { root: string; sourcePath?: string; list: (path: string) => Promise<{ entries: Entry[] }>; locate: (taskId: string) => Promise<{ path: string }>; read: (path: string) => Promise<{ path: string }> };
export async function resolveDocumentLink(link: DocumentLink, deps: Dependencies): Promise<string> {
  const target = link.target.split("#")[0].replace(/\.md$/i, "");
  if (taskPattern.test(target)) { const found = await deps.locate(target); return (await deps.read(found.path)).path; }
  const candidates = documentCandidates(link.target, deps.sourcePath, link.relative, deps.root), matches: string[] = [];
  for (const candidate of candidates) {
    const folder = candidate.split("/").slice(0, -1).join("/"); let result: { entries: Entry[] };
    try { result = await deps.list(folder); } catch (cause) { if (/ENOENT|no such file/i.test(String(cause))) continue; throw cause; }
    for (const entry of result.entries) if (entry.kind === "file" && entry.path === candidate && !matches.includes(entry.path)) matches.push(entry.path);
  }
  if (!matches.length) throw new Error("That document was not found in this vault.");
  if (matches.length > 1) throw new Error("That link matches more than one document. Use its full vault path.");
  return (await deps.read(matches[0])).path;
}
// Split structural table pipes, preserving wiki aliases, escaped pipes and inline code.
export function markdownTableCells(line: string): string[] {
  const value = line.trim(), cells: string[] = []; let cell = "", wiki = false, fence = 0;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "\\" && index + 1 < value.length) { cell += char + value[++index]; continue; }
    if (char === "`") { let count = 1; while (value[index + 1] === "`") { count++; index++; } if (!fence) fence = count; else if (fence === count) fence = 0; cell += "`".repeat(count); continue; }
    if (!fence && value.slice(index, index + 2) === "[[") wiki = true;
    if (!fence && value.slice(index, index + 2) === "]]") wiki = false;
    if (char === "|" && !wiki && !fence) { cells.push(cell.trim()); cell = ""; } else cell += char;
  }
  cells.push(cell.trim());
  if (value.startsWith("|") && cells[0] === "") cells.shift();
  if (value.endsWith("|") && cells[cells.length - 1] === "") cells.pop();
  return cells.map(value => value.replace(/\\\|/g, "|"));
}
