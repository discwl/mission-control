// Where a repository's origin lives, from its URL: GitHub, Azure DevOps Repos or Bitbucket Cloud. Pure, so
// client and server share it. A URL's user name and password are never kept or shown.

export const forges = ["github", "azure-devops", "bitbucket"] as const;
export type Forge = (typeof forges)[number];
export const forgeLabels: Record<Forge, string> = { github: "GitHub", "azure-devops": "Azure DevOps", bitbucket: "Bitbucket Cloud" };

/** How the forge was found: from the URL's own host, from Settings → Delivery's custom hosts, or from the project's override. */
export type ForgeSource = "detected" | "host-mapping" | "project-override";
export const forgeSourceLabels: Record<ForgeSource, string> = { detected: "detected", "host-mapping": "custom host", "project-override": "project override" };

export type ForgeRepository = { source: ForgeSource; webUrl: string } & (
  // host: github.com, or a GitHub Enterprise host (with its port, if any). slug is what `gh --repo` takes: owner/repo, or host/owner/repo off github.com.
  | { forge: "github"; host: string; owner: string; repo: string; slug: string }
  // organizationUrl is what `az --organization` takes: https://dev.azure.com/<org>, https://<org>.visualstudio.com, or an Azure DevOps
  // Server collection with its own scheme and port, such as http://tfs.corp:8080/tfs/DefaultCollection.
  | { forge: "azure-devops"; organization: string; organizationUrl: string; project: string; repo: string; slug: string }
  | { forge: "bitbucket"; workspace: string; repo: string; slug: string }
);

/**
 * A custom host or SSH host alias mapped to a forge (Settings → Delivery), such as a GitHub Enterprise domain,
 * an Azure DevOps Server, or `github-work` in git@github-work:org/repo.git. `host` is the forge's web address when
 * it differs from what the URL says: a host (github.com), a host and port, or a base URL (http://tfs.corp:8080) for
 * an SSH remote whose web address uses another scheme or port. Empty means the URL's own web address when it has
 * one (an http(s) remote keeps its scheme and port), else `match` when it is a domain, else the cloud host.
 */
export type ForgeHostMapping = { match: string; forge: Forge; host: string };
export type ForgeOptions = { hosts?: readonly ForgeHostMapping[]; override?: Forge };

// A web address: scheme, host name and port ("" for the scheme's default).
type Web = { scheme: "https" | "http"; host: string; port: string };
const cloud = (host: string): Web => ({ scheme: "https", host, port: "" });
const cloudWeb: Record<Forge, Web> = { github: cloud("github.com"), "azure-devops": cloud("dev.azure.com"), bitbucket: cloud("bitbucket.org") };
const authority = (web: Web) => `${web.host}${web.port ? `:${web.port}` : ""}`;
const origin = (web: Web) => `${web.scheme}://${authority(web)}`;

/** A host or SSH alias as a mapping may name it: letters, digits, dots and hyphens. */
export const forgeHostPattern = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,198}[A-Za-z0-9])?$/;
/** A mapping's web address: a host, a host and port, or an http(s) base URL with an optional port. */
export const forgeWebHostPattern = /^(?:https?:\/\/)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,198}[A-Za-z0-9])?(?::\d{1,5})?\/?$/i;

function webOf(text: string): Web | null {
  const value = text.trim();
  if (!value || !forgeWebHostPattern.test(value)) return null;
  const match = /^(?:(https?):\/\/)?([^:/]+)(?::(\d+))?\/?$/i.exec(value)!;
  const scheme = (match[1]?.toLowerCase() ?? "https") as Web["scheme"];
  const port = match[3] && !((scheme === "https" && match[3] === "443") || (scheme === "http" && match[3] === "80")) ? match[3] : "";
  return { scheme, host: match[2].toLowerCase(), port };
}

/** The URL without a user name or password, as Mission Control may show it. */
export function redactRemoteUrl(url: string): string {
  const text = url.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
  // scp-like user@host:path keeps the user (it's the SSH account, such as git), never a password.
  return text.replace(/^([^@/:]+):[^@/]*@/, "$1@");
}

// The URL's host (for matching and detection), its path segments, and its web address when it is an http(s) URL.
function parts(url: string): { host: string; path: string[]; web: Web | null } | null {
  const text = url.trim();
  let host: string;
  let path: string;
  let web: Web | null = null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  if (scheme) {
    if (!["https", "http", "ssh", "git+ssh", "ssh+git", "git"].includes(scheme[1].toLowerCase())) return null;
    let parsed: URL;
    try { parsed = new URL(text.replace(/^(git\+ssh|ssh\+git):/i, "ssh:")); } catch { return null; }
    host = parsed.hostname;
    path = parsed.pathname;
    // An http(s) remote is the web address too, scheme and port included (URL drops a default port).
    if (parsed.protocol === "https:" || parsed.protocol === "http:") web = { scheme: parsed.protocol === "http:" ? "http" : "https", host: host.toLowerCase(), port: parsed.port };
  } else {
    // scp-like: [user@]host:path, where the host has no slash before the colon. A one-letter host is a Windows drive.
    const scp = /^(?:[^@/]+@)?([^:/\\]{2,}):(.+)$/.exec(text);
    if (!scp) return null;
    host = scp[1];
    path = scp[2];
  }
  let segments: string[];
  try { segments = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).map(segment => decodeURIComponent(segment)); } catch { return null; }
  if (segments.length) segments[segments.length - 1] = segments[segments.length - 1].replace(/\.git$/i, "");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) return null;
  return { host: host.toLowerCase(), path: segments, web };
}

const azure = (source: ForgeSource, organization: string, organizationUrl: string, project: string, repo: string): ForgeRepository => ({
  forge: "azure-devops", source, organization, organizationUrl, project, repo, slug: `${organization}/${project}/${repo}`,
  webUrl: `${organizationUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`,
});

/** The repository at `path` on `forge`, whose web address is `web`; null when the path doesn't have that forge's shape. */
function repository(forge: Forge, web: Web, path: string[], source: ForgeSource): ForgeRepository | null {
  const host = web.host;
  if (forge === "github") {
    if (path.length !== 2) return null;
    const [owner, repo] = path;
    const name = authority(web);
    return { forge, source, host: name, owner, repo, slug: name === "github.com" ? `${owner}/${repo}` : `${name}/${owner}/${repo}`, webUrl: `${origin(web)}/${owner}/${repo}` };
  }
  if (forge === "bitbucket") {
    // Bitbucket Cloud only: its API is api.bitbucket.org, whatever alias the URL uses.
    if (path.length !== 2) return null;
    const [workspace, repo] = path;
    return { forge, source, workspace, repo, slug: `${workspace}/${repo}`, webUrl: `https://bitbucket.org/${workspace}/${repo}` };
  }
  // SSH: v3/<org>/<project>/<repo> (ssh.dev.azure.com, vs-ssh.visualstudio.com, or an alias for them).
  if (path[0] === "v3") {
    if (path.length !== 4) return null;
    const [, organization, project, repo] = path;
    return azure(source, organization, host === "vs-ssh.visualstudio.com" ? `https://${organization}.visualstudio.com` : `https://dev.azure.com/${organization}`, project, repo);
  }
  // HTTPS: dev.azure.com/<org>/<project>/_git/<repo>, or <org>/_git/<repo> when the project has the repository's name.
  if (host === "dev.azure.com" || host === "ssh.dev.azure.com") {
    const at = path.indexOf("_git");
    if (at < 1 || at > 2 || path.length !== at + 2) return null;
    const organization = path[0];
    const repo = path[at + 1];
    return azure(source, organization, `https://dev.azure.com/${organization}`, at === 2 ? path[1] : repo, repo);
  }
  // HTTPS: <org>.visualstudio.com[/DefaultCollection]/<project>/_git/<repo>.
  const legacy = /^([a-z0-9][a-z0-9-]*)\.visualstudio\.com$/.exec(host);
  if (legacy) {
    const rest = path[0]?.toLowerCase() === "defaultcollection" ? path.slice(1) : path;
    const at = rest.indexOf("_git");
    if (at < 0 || at > 1 || rest.length !== at + 2) return null;
    const repo = rest[at + 1];
    return azure(source, legacy[1], `https://${legacy[1]}.visualstudio.com`, at === 1 ? rest[0] : repo, repo);
  }
  // Azure DevOps Server: [tfs/]<collection>/<project>/_git/<repo>, or [tfs/]<collection>/_git/<repo> when the project has
  // the repository's name. The collection, with the server's own scheme and port, is what az --organization takes.
  const collectionLength = path[0]?.toLowerCase() === "tfs" ? 2 : 1;
  const collection = path.slice(0, collectionLength);
  const rest = path.slice(collectionLength);
  if (collection.length !== collectionLength) return null;
  const organizationUrl = `${origin(web)}/${collection.map(encodeURIComponent).join("/")}`;
  if (rest.length === 2 && rest[0] === "_git") return azure(source, collection.at(-1)!, organizationUrl, rest[1], rest[1]);
  if (rest.length === 3 && rest[1] === "_git") return azure(source, collection.at(-1)!, organizationUrl, rest[0], rest[2]);
  return null;
}

/**
 * The forge's web address for this URL: the mapping's web host; else the URL's own when it is http(s) (scheme and
 * port kept); else the URL's host when it is a domain; else the cloud host (an SSH alias).
 */
function effectiveWeb(forge: Forge, mapping: ForgeHostMapping | undefined, found: { host: string; web: Web | null }): Web {
  const named = mapping ? webOf(mapping.host) : null;
  if (named) return named;
  if (forge === "bitbucket") return cloudWeb.bitbucket;
  // Cloud SSH hosts keep their own shape rules.
  if (forge === "azure-devops" && (found.host === "ssh.dev.azure.com" || found.host === "vs-ssh.visualstudio.com")) return cloud(found.host);
  if (forge === "github" && (found.host === "ssh.github.com" || found.host === "www.github.com")) return cloudWeb.github;
  if (found.web) return found.web;
  return found.host.includes(".") ? cloud(found.host) : cloudWeb[forge];
}

function builtIn(found: { host: string; path: string[]; web: Web | null }): ForgeRepository | null {
  const { host, path } = found;
  if (host === "github.com" || host === "www.github.com" || host === "ssh.github.com") return repository("github", cloudWeb.github, path, "detected");
  if (host === "bitbucket.org" || host === "www.bitbucket.org") return repository("bitbucket", cloudWeb.bitbucket, path, "detected");
  if (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com") return path[0] === "v3" ? repository("azure-devops", cloud(host), path, "detected") : null;
  if (host === "dev.azure.com" || /^[a-z0-9][a-z0-9-]*\.visualstudio\.com$/.test(host)) return repository("azure-devops", cloud(host), path, "detected");
  return null;
}

/**
 * The forge and repository origin's URL points at, or null. A project's override wins; then a custom host
 * mapping for the URL's host; then the built-in hosts (github.com, dev.azure.com, *.visualstudio.com, bitbucket.org).
 */
export function detectForge(url: string, options: ForgeOptions = {}): ForgeRepository | null {
  const found = parts(url);
  if (!found) return null;
  const mapping = options.hosts?.find(entry => entry.match.trim().toLowerCase() === found.host);
  if (options.override) return repository(options.override, effectiveWeb(options.override, mapping, found), found.path, "project-override");
  if (mapping) return repository(mapping.forge, effectiveWeb(mapping.forge, mapping, found), found.path, "host-mapping");
  return builtIn(found);
}
