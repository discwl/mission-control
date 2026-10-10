import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile, link } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { VaultEntry, VaultFile } from "../shared/vault";

const MAX_TEXT_BYTES = 200_000;
const MAX_IMAGE_BYTES = 2_000_000;
const taskId = /^task_[a-f0-9-]+$/i;
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export function normalizeVaultPath(value: string): string {
  if (!value) return "";
  const parts = value.replaceAll("\\", "/").split("/");
  if (isAbsolute(value) || parts.some(part => !part || part === "." || part === ".." || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("Use a relative path inside the vault, with valid folder and file names.");
  }
  return parts.join("/");
}
function protection(path: string): string | null {
  const parts = path.toLowerCase().split("/");
  if (parts.some(part => part === ".obsidian" || part === ".git" || part === ".trash" || part.startsWith(".mission-control"))) return "Vault settings and internal files are read only.";
  if (path.toLowerCase() === "host.json") return "Host identity is managed by Development Flow.";
  if (parts[0] === "tasks" && (/^task_[a-f0-9-]+\.md$/i.test(parts[1] ?? "") || (taskId.test(parts[1] ?? "") && (parts[2] === "task.md" || parts[2] === "runs")))) return "Task metadata and run evidence are read only. Use the Tasks workflow to update them.";
  return null;
}
function structuralProtection(path: string): string | null {
  const parts = path.split("/");
  return protection(path) ?? (parts[0]?.toLowerCase() === "tasks" && (parts.length === 1 || (parts.length === 2 && taskId.test(parts[1]))) ? "Task folders keep their IDs and location so workspace links remain valid." : null);
}
function defaultObsidianConfig(): string {
  return process.platform === "win32" ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "obsidian", "obsidian.json")
    : process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json")
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "obsidian", "obsidian.json");
}

/** All paths and writes belong to one configured host-local vault. No client-supplied roots. */
export function createVaultStore(rootPath: string, obsidianConfigPath: string | null = defaultObsidianConfig()) {
  const root = resolve(rootPath);
  const compare = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  async function checkedRoot() {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The vault root must be a real folder, not a link.");
    const actual = await realpath(root);
    if (compare(actual) !== compare(root)) throw new Error("The vault root must not pass through linked folders.");
    return root;
  }
  async function safePath(value: string, allowMissingLeaf = false) {
    const path = normalizeVaultPath(value);
    await checkedRoot();
    let current = root;
    const parts = path ? path.split("/") : [];
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) throw new Error("Linked files and folders cannot be opened or changed through the vault browser.");
        if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("A parent path is not a folder.");
      } catch (error) { if (!(allowMissingLeaf && index === parts.length - 1 && missing(error))) throw error; }
    }
    const remainder = relative(root, current);
    if (remainder.startsWith(`..${sep}`) || remainder === ".." || isAbsolute(remainder)) throw new Error("Path must stay inside the vault.");
    return current;
  }
  async function withLock<T>(folder: string, action: () => Promise<T>): Promise<T> {
    const file = join(folder, ".mission-control-write.lock");
    let handle;
    try { handle = await open(file, "wx"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("This folder is being updated. Retry when the other save finishes."); throw error; }
    try { return await action(); }
    finally { await handle.close(); await unlink(file); }
  }
  async function withMutation<T>(path: string, action: () => Promise<T>): Promise<T> {
    return withLock(root, async () => {
      const parts = path.split("/");
      // Share the existing task writer's lock for note/status writes inside a task.
      const folder = parts[0]?.toLowerCase() === "tasks" && taskId.test(parts[1] ?? "") ? await safePath(parts.slice(0, 2).join("/")) : dirname(join(root, path));
      return compare(folder) === compare(root) ? action() : withLock(folder, action);
    });
  }
  async function entry(path: string): Promise<VaultEntry> {
    const file = join(root, path);
    const stat = await lstat(file);
    const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "folder" : "file";
    const reason = kind === "link" ? "Linked files and folders are not followed." : structuralProtection(path);
    return { path, name: basename(file), kind, size: stat.size, updatedAt: stat.mtime.toISOString(), revision: hash(`${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`), editable: kind === "file" && /\.md$/i.test(path) && !protection(path) && stat.size <= MAX_TEXT_BYTES, manageable: !!path && !reason, reason };
  }
  async function status() {
    let exists = false;
    try { await checkedRoot(); exists = true; } catch (error) { if (!missing(error)) throw error; }
    let initialized = false;
    if (exists) {
      try { const config = await safePath(".obsidian"); initialized = (await lstat(config)).isDirectory(); } catch (error) { if (!missing(error)) throw error; }
    }
    let obsidianRegistered: boolean | null = null;
    let obsidianVaultId: string | null = null;
    if (obsidianConfigPath) {
      try {
        const config = JSON.parse(await readFile(obsidianConfigPath, "utf8"));
        const match = Object.entries(config.vaults ?? {}).find(([, value]) => value && typeof value === "object" && "path" in value && typeof value.path === "string" && compare(resolve(value.path)) === compare(root));
        obsidianRegistered = !!match;
        obsidianVaultId = match?.[0] ?? null;
      } catch { /* Missing/unreadable app registry is unknown; never rewrite Obsidian's private registry. */ }
    }
    return { root, name: basename(root), exists, initialized, obsidianRegistered, obsidianVaultId };
  }
  async function initialize() {
    await mkdir(root, { recursive: true });
    await checkedRoot();
    return withLock(root, async () => {
      const folder = await safePath(".obsidian", true);
      await mkdir(folder, { recursive: true });
      const file = await safePath(".obsidian/app.json", true);
      try { await writeFile(file, "{}\n", { flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      return status();
    });
  }
  async function list(pathValue: string) {
    const path = normalizeVaultPath(pathValue);
    const folder = await safePath(path);
    if (!(await lstat(folder)).isDirectory()) throw new Error("Select a folder.");
    const names = (await readdir(folder)).filter(name => name !== ".mission-control-write.lock" && !/^\..+\.tmp$/.test(name));
    const entries: VaultEntry[] = [];
    for (const name of names) {
      try { entries.push(await entry(path ? `${path}/${name}` : name)); } catch (error) { if (!missing(error)) throw error; }
    }
    entries.sort((a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { entries };
  }
  async function read(pathValue: string): Promise<VaultFile> {
    const path = normalizeVaultPath(pathValue);
    const file = await safePath(path);
    const info = await entry(path);
    if (info.kind !== "file") throw new Error("Select a regular file to preview.");
    const text = /\.(md|txt|json|ya?ml|csv|css|js|ts|html|xml|log|base|canvas)$/i.test(path) || info.name.startsWith(".");
    const imageType = /\.(png|jpe?g|gif|webp)$/i.exec(path)?.[1].toLowerCase();
    const preview = text && info.size <= MAX_TEXT_BYTES ? (/\.md$/i.test(path) ? "markdown" : "text") : imageType && info.size <= MAX_IMAGE_BYTES ? "image" : "unsupported";
    if (preview === "unsupported") return { ...info, entryRevision: info.revision, editable: false, content: null, dataUrl: null, preview, reason: info.reason ?? "This file is available in the vault. Open it in Obsidian to view this format or a larger file." };
    const handle = await open(file, "r");
    try {
      const stat = await handle.stat();
      const limit = preview === "image" ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
      if (stat.size > limit) throw new Error("This file became too large to preview. Reload its folder.");
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error("This file changed while it was being read. Reload it.");
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("This file changed while it was being read. Reload it.");
      return { ...info, entryRevision: info.revision, revision: hash(bytes), content: preview === "image" ? null : bytes.toString("utf8"), dataUrl: preview === "image" ? `data:image/${imageType === "jpg" ? "jpeg" : imageType};base64,${bytes.toString("base64")}` : null, preview };
    } finally { await handle.close(); }
  }
  async function save(input: { path: string; content: string; revision: string }) {
    const path = normalizeVaultPath(input.path);
    if (!/\.md$/i.test(path) || protection(path)) throw new Error(protection(path) ?? "Only Markdown notes can be edited here.");
    if (Buffer.byteLength(input.content, "utf8") > MAX_TEXT_BYTES) throw new Error("Note is too large. The editing limit is 200 KB.");
    await safePath(path);
    return withMutation(path, async () => {
      const file = await safePath(path);
      const current = await read(path);
      if (current.revision !== input.revision) throw new Error("This note changed outside Mission Control. Copy your draft, then reload before saving.");
      const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
      try { await writeFile(temporary, input.content, { flag: "wx" }); await rename(temporary, file); }
      finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
      return read(path);
    });
  }
  async function create(input: { path: string; kind: "folder" | "note" }) {
    const path = normalizeVaultPath(input.path);
    if (!path || structuralProtection(path)) throw new Error(structuralProtection(path) ?? "Choose a name inside the vault.");
    if (input.kind === "note" && !/\.md$/i.test(path)) throw new Error("New notes must end in .md.");
    await safePath(path, true);
    return withMutation(path, async () => {
      const file = await safePath(path, true);
      if (input.kind === "folder") await mkdir(file);
      else await writeFile(file, `# ${basename(path, ".md")}\n\n`, { flag: "wx" });
      return entry(path);
    });
  }
  async function assertRevision(path: string, revision: string) {
    if ((await entry(path)).revision !== revision) throw new Error("This item changed. Refresh its folder before moving or removing it.");
  }
  async function move(input: { path: string; destination: string; revision: string }) {
    const path = normalizeVaultPath(input.path), destination = normalizeVaultPath(input.destination);
    if (!path || !destination || structuralProtection(path) || structuralProtection(destination)) throw new Error(structuralProtection(path) ?? structuralProtection(destination) ?? "The vault root cannot be moved.");
    if (compare(destination) === compare(path) || compare(destination).startsWith(`${compare(path)}/`)) throw new Error("Choose a different location outside this folder.");
    await safePath(path); await safePath(destination, true);
    return withMutation(path, async () => {
      const source = await safePath(path), target = await safePath(destination, true);
      await assertRevision(path, input.revision);
      try { await lstat(target); throw new Error("That destination already exists. Choose another name."); } catch (error) { if (!missing(error)) throw error; }
      if ((await lstat(source)).isFile()) { await link(source, target); await unlink(source); }
      else await rename(source, target);
      return entry(destination);
    });
  }
  async function trash(input: { path: string; revision: string }) {
    const path = normalizeVaultPath(input.path);
    if (!path || structuralProtection(path)) throw new Error(structuralProtection(path) ?? "The vault root cannot be removed.");
    await safePath(path);
    return withMutation(path, async () => {
      const source = await safePath(path);
      await assertRevision(path, input.revision);
      const trashRoot = await safePath(".trash", true);
      await mkdir(trashRoot, { recursive: true });
      const folder = await safePath(`.trash/${randomUUID()}`, true);
      await mkdir(folder);
      const target = join(folder, basename(source));
      await rename(source, target);
      return { trashedPath: relative(root, target).split(sep).join("/") };
    });
  }
  async function locateTask(task: string) {
    if (!taskId.test(task)) throw new Error("Invalid task ID.");
    for (const path of [`Tasks/${task}/task.md`, `Tasks/${task}.md`]) {
      try { await safePath(path); return { path }; } catch (error) { if (!missing(error)) throw error; }
    }
    throw new Error("That task document is no longer in this vault.");
  }
  return { status, initialize, list, read, save, create, move, trash, locateTask };
}
