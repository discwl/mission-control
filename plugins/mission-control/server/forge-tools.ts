import { stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { hideCredentials } from "../shared/secret-mask";
import { runProcess, type ProcessResult } from "./process-tree";

// The forge tools Open PR runs: gh for GitHub, az with the azure-devops extension for Azure DevOps, and
// Bitbucket Cloud's REST API with credentials from the environment or Git's credential store. Nothing here
// stores, logs or returns a credential; command output is scrubbed before anyone sees it.

export type Env = Record<string, string | undefined>;
/** A tool as it runs: its executable and the arguments that come before the tool's own (az's python -IBm azure.cli). */
export type ToolCommand = { file: string; prefix: string[]; env?: Env; label: string };
export type ToolRunner = (command: ToolCommand, args: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<ProcessResult>;

const isFile = async (path: string) => { try { return (await stat(path)).isFile(); } catch { return false; } };

function pathDirs(env: Env) {
  const key = Object.keys(env).find(name => name.toLowerCase() === "path");
  return (key ? env[key] ?? "" : "").split(delimiter).map(entry => entry.trim().replace(/^"(.*)"$/, "$1")).filter(entry => isAbsolute(entry));
}

async function onPath(env: Env, names: string[]) {
  for (const dir of pathDirs(env)) for (const name of names) if (await isFile(join(dir, name))) return join(dir, name);
  return null;
}

/** gh on PATH (gh.exe on Windows), or null. */
export async function findGh(env: Env = process.env, platform = process.platform): Promise<ToolCommand | null> {
  const file = await onPath(env, [platform === "win32" ? "gh.exe" : "gh"]);
  // gh never prompts: prompts are off and there is no terminal.
  return file ? { file, prefix: [], label: "gh", env: { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" } } : null;
}

/**
 * az, or null. On Windows az is az.cmd, which runs the bundled python.exe with -IBm azure.cli; Mission Control
 * runs that python.exe itself, since a .cmd file would need a shell.
 */
export async function findAz(env: Env = process.env, platform = process.platform): Promise<ToolCommand | null> {
  const quiet = { AZURE_CORE_ONLY_SHOW_ERRORS: "1", AZURE_CORE_NO_COLOR: "1", AZURE_CORE_COLLECT_TELEMETRY: "0", AZURE_EXTENSION_USE_DYNAMIC_INSTALL: "no" };
  if (platform !== "win32") {
    const file = await onPath(env, ["az"]);
    return file ? { file, prefix: [], label: "az", env: quiet } : null;
  }
  const cmd = await onPath(env, ["az.cmd"]);
  if (!cmd) return null;
  const python = join(dirname(dirname(cmd)), "python.exe");
  return await isFile(python) ? { file: python, prefix: ["-IBm", "azure.cli"], label: "az", env: { ...quiet, AZ_INSTALLER: "MSI" } } : null;
}

/** Runs a tool without a shell; at the time limit its whole process tree ends. */
export const runTool: ToolRunner = (command, args, options = {}) =>
  runProcess(command.file, [...command.prefix, ...args], { cwd: options.cwd, env: { ...process.env, ...command.env }, timeoutMs: options.timeoutMs ?? 60_000, maxBuffer: 8 * 1024 * 1024 });

/** A tool's error for a person: its stderr (or stdout), first lines only, with key-like strings and URL credentials hidden. */
export function toolError(result: ProcessResult, fallback: string) {
  const text = hideCredentials((result.stderr.trim() || result.stdout.trim() || fallback).replace(/\u001b\[[0-9;]*m/g, ""));
  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.length > 6 ? `${lines.slice(0, 6).join(" ")} …` : lines.join(" ");
}

// ---------- sign-in ----------

export type SignIn = { signedIn: boolean; detail: string };

/** Whether gh is signed in to github.com: `gh auth status` exits 0 when it is. */
export async function ghSignIn(gh: ToolCommand, run: ToolRunner = runTool, host = "github.com"): Promise<SignIn> {
  const result = await run(gh, ["auth", "status", "--hostname", host], { timeoutMs: 20_000 });
  const text = `${result.stdout}\n${result.stderr}`;
  const account = /account\s+([A-Za-z0-9-]+)/.exec(text)?.[1] ?? /as\s+([A-Za-z0-9-]+)/.exec(text)?.[1];
  if (result.code === 0) return { signedIn: true, detail: `Signed in to ${host}${account ? ` as ${account}` : ""}.` };
  return { signedIn: false, detail: `Not signed in to ${host}. Run: gh auth login${host === "github.com" ? "" : ` --hostname ${host}`}` };
}

const isAzureCloud = (organizationUrl: string) => /^https:\/\/(dev\.azure\.com\/|[a-z0-9-]+\.visualstudio\.com)/i.test(organizationUrl);

/** What to run to sign in to an organization: az login works only for Azure DevOps Services; a Server needs a personal access token. */
function azSignInAdvice(organizationUrl: string) {
  return isAzureCloud(organizationUrl)
    ? `Run: az login, or az devops login --organization ${organizationUrl}`
    : `Run: az devops login --organization ${organizationUrl} (Azure DevOps Server needs a personal access token), or set AZURE_DEVOPS_EXT_PAT for the Paseo daemon`;
}

/**
 * Whether az has the azure-devops extension and can reach each organization. AZURE_DEVOPS_EXT_PAT counts as signed
 * in. Otherwise each organization is asked with a real az devops call, which works for az login (Azure DevOps
 * Services) and for az devops login's stored personal access token (the only sign-in Azure DevOps Server accepts).
 * With no organization to ask, az login (az account show) is the check.
 */
export async function azSignIn(az: ToolCommand, env: Env = process.env, run: ToolRunner = runTool, organizationUrls: readonly string[] = []): Promise<SignIn & { extension: string | null }> {
  const extension = await run(az, ["extension", "show", "--name", "azure-devops", "--output", "json"], { timeoutMs: 30_000 });
  let version: string | null = null;
  if (extension.code === 0) { try { version = String(JSON.parse(extension.stdout).version ?? "") || "installed"; } catch { version = "installed"; } }
  if (!version) return { signedIn: false, extension: null, detail: "The azure-devops extension isn't installed. Run: az extension add --name azure-devops" };
  if (env.AZURE_DEVOPS_EXT_PAT) return { signedIn: true, extension: version, detail: `azure-devops ${version}; signed in with AZURE_DEVOPS_EXT_PAT.` };
  if (organizationUrls.length) {
    const answers = await Promise.all(organizationUrls.map(async organizationUrl => {
      const result = await run(az, ["devops", "project", "list", "--organization", organizationUrl, "--top", "1", "--detect", "false", "--output", "json"], { timeoutMs: 45_000 });
      return result.code === 0 ? { ok: true, text: `signed in to ${organizationUrl}` } : { ok: false, text: `not signed in to ${organizationUrl}. ${azSignInAdvice(organizationUrl)}` };
    }));
    return { signedIn: answers.every(answer => answer.ok), extension: version, detail: `azure-devops ${version}; ${answers.map(answer => answer.text).join("; ")}.` };
  }
  const account = await run(az, ["account", "show", "--output", "json"], { timeoutMs: 30_000 });
  if (account.code !== 0) return { signedIn: false, extension: version, detail: `azure-devops ${version}; not signed in. Run: az login (Azure DevOps Services), or az devops login --organization <URL> (Azure DevOps Server)` };
  let user = "";
  try { user = String(JSON.parse(account.stdout).user?.name ?? ""); } catch { /* Signed in; the name is only shown. */ }
  return { signedIn: true, extension: version, detail: `azure-devops ${version}; signed in${user ? ` as ${hideCredentials(user)}` : ""}.` };
}

// ---------- Bitbucket Cloud ----------

/** The Authorization header for Bitbucket Cloud's API and where it came from; never shown or kept. */
export type BitbucketAuth = { header: string; source: string };

/** `git credential fill` for https://<host>: its arguments, input and environment, so no prompt or window can appear. */
export function credentialFill(host: string, env: Env) {
  return {
    args: ["-c", "credential.interactive=never", "credential", "fill"],
    input: `protocol=https\nhost=${host}\n\n`,
    // No terminal prompt, no askpass program and no Git Credential Manager window: a missing credential is just missing.
    env: { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "" },
  };
}

/** The user name and password in `git credential fill`'s answer, or null. */
export function parseCredential(result: { code: number | null; stdout: string }): { username: string; password: string } | null {
  if (result.code !== 0) return null;
  const fields = new Map(result.stdout.split(/\r?\n/).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const));
  const username = fields.get("username");
  const password = fields.get("password");
  return username && password ? { username, password } : null;
}

/** Git's stored credential for https://<host>, asked for without any prompt or window, or null. */
export async function gitCredential(host: string, env: Env = process.env): Promise<{ username: string; password: string } | null> {
  const fill = credentialFill(host, env);
  try { return parseCredential(await runProcess("git", fill.args, { input: fill.input, env: fill.env, timeoutMs: 15_000, maxBuffer: 64 * 1024 })); }
  catch { return null; }
}

/**
 * Bitbucket Cloud credentials: BITBUCKET_TOKEN (an access token, sent as Bearer), else BITBUCKET_USERNAME with
 * BITBUCKET_APP_PASSWORD (Basic), else Git's credential store for bitbucket.org (Basic). Null when none exist.
 */
export async function bitbucketAuth(env: Env = process.env, credential: (host: string, env: Env) => Promise<{ username: string; password: string } | null> = gitCredential): Promise<BitbucketAuth | null> {
  if (env.BITBUCKET_TOKEN?.trim()) return { header: `Bearer ${env.BITBUCKET_TOKEN.trim()}`, source: "the BITBUCKET_TOKEN environment variable" };
  if (env.BITBUCKET_USERNAME?.trim() && env.BITBUCKET_APP_PASSWORD?.trim()) {
    return { header: `Basic ${Buffer.from(`${env.BITBUCKET_USERNAME.trim()}:${env.BITBUCKET_APP_PASSWORD.trim()}`).toString("base64")}`, source: "the BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD environment variables" };
  }
  const stored = await credential("bitbucket.org", env);
  return stored ? { header: `Basic ${Buffer.from(`${stored.username}:${stored.password}`).toString("base64")}`, source: "Git's credential store" } : null;
}

export type HttpRequest = { method: "GET" | "POST"; url: string; headers: Record<string, string>; body?: string };
export type HttpResponse = { status: number; text: string };
export type Http = (request: HttpRequest) => Promise<HttpResponse>;

/** fetch with a time limit; redirects aren't followed, so the Authorization header never goes elsewhere. */
export const httpRequest: Http = async request => {
  const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  return { status: response.status, text: await response.text() };
};

/** A Bitbucket API error for a person: its message, with key-like strings and URL credentials hidden. */
export function bitbucketError(response: HttpResponse) {
  let message = "";
  try { const parsed = JSON.parse(response.text); message = String(parsed?.error?.message ?? parsed?.error?.detail ?? ""); } catch { /* Not JSON. */ }
  const hint = response.status === 401 || response.status === 403 ? " Check the Bitbucket credentials (they need pull request write access)." : "";
  return hideCredentials(`Bitbucket answered ${response.status}${message ? `: ${message}` : ""}.${hint}`);
}
