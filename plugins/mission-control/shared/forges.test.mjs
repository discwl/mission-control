import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { detectForge, redactRemoteUrl } = require("./forges.ts");
const { deliveryFor, examplePullRequestTitle, pullRequestTitle, pullRequestTitleProblem } = require("./delivery.ts");

test("GitHub, Azure DevOps and Bitbucket Cloud are recognised from origin's URL in every usual form", () => {
  const github = { forge: "github", source: "detected", host: "github.com", owner: "acme", repo: "widgets", slug: "acme/widgets", webUrl: "https://github.com/acme/widgets" };
  for (const url of ["https://github.com/acme/widgets.git", "https://github.com/acme/widgets", "https://user:secret@github.com/acme/widgets.git", "git@github.com:acme/widgets.git", "ssh://git@github.com/acme/widgets.git", "ssh://git@ssh.github.com:443/acme/widgets.git", "https://github.com/acme/widgets/"]) {
    assert.deepEqual(detectForge(url), github, url);
  }
  const azure = { forge: "azure-devops", source: "detected", organization: "contoso", organizationUrl: "https://dev.azure.com/contoso", project: "Web Shop", repo: "api", slug: "contoso/Web Shop/api", webUrl: "https://dev.azure.com/contoso/Web%20Shop/_git/api" };
  for (const url of ["https://dev.azure.com/contoso/Web%20Shop/_git/api", "https://contoso@dev.azure.com/contoso/Web%20Shop/_git/api", "git@ssh.dev.azure.com:v3/contoso/Web%20Shop/api"]) {
    assert.deepEqual(detectForge(url), azure, url);
  }
  const legacy = { ...azure, organizationUrl: "https://contoso.visualstudio.com", webUrl: "https://contoso.visualstudio.com/Web%20Shop/_git/api" };
  for (const url of ["https://contoso.visualstudio.com/Web%20Shop/_git/api", "https://contoso.visualstudio.com/DefaultCollection/Web%20Shop/_git/api", "contoso@vs-ssh.visualstudio.com:v3/contoso/Web%20Shop/api"]) {
    assert.deepEqual(detectForge(url), legacy, url);
  }
  // A repository in a project of the same name can drop the project.
  assert.equal(detectForge("https://dev.azure.com/contoso/_git/api").project, "api");
  const bitbucket = { forge: "bitbucket", source: "detected", workspace: "team", repo: "app", slug: "team/app", webUrl: "https://bitbucket.org/team/app" };
  for (const url of ["https://bitbucket.org/team/app.git", "https://someone@bitbucket.org/team/app.git", "git@bitbucket.org:team/app.git"]) {
    assert.deepEqual(detectForge(url), bitbucket, url);
  }
});

test("other hosts and shapes are unknown", () => {
  for (const url of ["https://gitlab.com/acme/widgets.git", "https://github.example.com/acme/widgets.git", "https://bitbucket.example.com/scm/team/app.git", "C:\\repos\\widgets", "/srv/git/widgets.git",
    "file:///srv/git/widgets.git", "https://github.com/acme", "https://github.com/acme/widgets/tree/main", "https://dev.azure.com/contoso/project/api", "https://github.com/acme/../widgets", ""]) {
    assert.equal(detectForge(url), null, url);
  }
});

test("a remote URL loses its user name and password before it is shown", () => {
  assert.equal(redactRemoteUrl("https://user:ghp_secret@github.com/acme/widgets.git"), "https://github.com/acme/widgets.git");
  assert.equal(redactRemoteUrl("https://contoso@dev.azure.com/contoso/p/_git/r"), "https://dev.azure.com/contoso/p/_git/r");
  assert.equal(redactRemoteUrl("git@github.com:acme/widgets.git"), "git@github.com:acme/widgets.git");
  assert.equal(redactRemoteUrl("user:pass@host:path"), "user@host:path");
});

test("a pull request title follows the template, dropping a missing ticket with its separator", () => {
  const ticket = { system: "jira", key: "ABC-7", url: "https://example.atlassian.net/browse/ABC-7", type: "Bug" };
  const task = { taskId: "task_1234abcd-0000", title: "ABC-7 · Fix login retry", ticket };
  assert.equal(pullRequestTitle("", task), "ABC-7: Fix login retry");
  assert.equal(pullRequestTitle("{ticket}: {title}", { taskId: "task_1234abcd", title: "Add greeting" }), "Add greeting");
  assert.equal(pullRequestTitle("[{ticket}] {type}/{slug} ({id})", task), "[ABC-7] bugfix/fix-login-retry (1234abcd)");
  assert.equal(pullRequestTitle("{title} - {ticket}", { taskId: "task_1", title: "Add greeting" }), "Add greeting");
  assert.equal(examplePullRequestTitle("{ticket}: {title}"), "ABC-123: Add login retry");
  assert.equal(pullRequestTitleProblem(""), null);
  assert.equal(pullRequestTitleProblem("{ticket}: {title}"), null);
  assert.match(pullRequestTitleProblem("{ticket}: {name}"), /\{name\} isn't a token/);
  assert.match(pullRequestTitleProblem("{ticket}"), /Include \{title\} or \{slug\}/);
  assert.match(pullRequestTitleProblem("{title"), /both braces/);
});

test("a project's delivery overrides the host's, and an empty template falls back to the default", () => {
  const hosts = [{ match: "github-work", forge: "github", host: "" }];
  const settings = { mode: "merge", titleTemplate: "", forgeHosts: hosts, projects: { prj_work: { mode: "pull-request", forge: "azure-devops" }, prj_named: { titleTemplate: "{title}" } } };
  assert.deepEqual(deliveryFor(settings, "prj_personal"), { mode: "merge", titleTemplate: "{ticket}: {title}", modeSource: "host", forge: { hosts } });
  assert.deepEqual(deliveryFor(settings, "prj_work"), { mode: "pull-request", titleTemplate: "{ticket}: {title}", modeSource: "project", forge: { hosts, override: "azure-devops" } });
  assert.deepEqual(deliveryFor({ ...settings, mode: "pull-request", titleTemplate: "[{ticket}] {title}" }, "prj_named"), { mode: "pull-request", titleTemplate: "{title}", modeSource: "host", forge: { hosts } });
});

test("custom hosts map SSH aliases and custom domains to a forge", () => {
  const hosts = [
    { match: "github-work", forge: "github", host: "" },
    { match: "github.example.com", forge: "github", host: "" },
    { match: "ghe-ssh", forge: "github", host: "github.example.com" },
    { match: "tfs.corp.example", forge: "azure-devops", host: "" },
    { match: "ado-work", forge: "azure-devops", host: "" },
    { match: "bb-work", forge: "bitbucket", host: "" },
  ];
  // An alias of github.com: gh uses owner/repo on github.com.
  assert.deepEqual(detectForge("git@github-work:acme/widgets.git", { hosts }), { forge: "github", source: "host-mapping", host: "github.com", owner: "acme", repo: "widgets", slug: "acme/widgets", webUrl: "https://github.com/acme/widgets" });
  assert.equal(detectForge("git@GitHub-Work:acme/widgets.git", { hosts })?.slug, "acme/widgets", "hosts match without regard to case");
  // GitHub Enterprise: gh takes host/owner/repo.
  const enterprise = { forge: "github", source: "host-mapping", host: "github.example.com", owner: "acme", repo: "widgets", slug: "github.example.com/acme/widgets", webUrl: "https://github.example.com/acme/widgets" };
  assert.deepEqual(detectForge("https://github.example.com/acme/widgets.git", { hosts }), enterprise);
  assert.deepEqual(detectForge("git@github.example.com:acme/widgets.git", { hosts }), enterprise);
  assert.deepEqual(detectForge("git@ghe-ssh:acme/widgets.git", { hosts }), enterprise, "an alias whose web host is set");
  // Azure DevOps Server: the collection is the organization URL.
  assert.deepEqual(detectForge("https://tfs.corp.example/tfs/DefaultCollection/Web%20Shop/_git/api", { hosts }), {
    forge: "azure-devops", source: "host-mapping", organization: "DefaultCollection", organizationUrl: "https://tfs.corp.example/tfs/DefaultCollection", project: "Web Shop", repo: "api",
    slug: "DefaultCollection/Web Shop/api", webUrl: "https://tfs.corp.example/tfs/DefaultCollection/Web%20Shop/_git/api",
  });
  // An alias of ssh.dev.azure.com keeps the v3 shape and Azure DevOps Services' organization URL.
  assert.equal(detectForge("git@ado-work:v3/contoso/Web%20Shop/api", { hosts })?.slug, "contoso/Web Shop/api");
  assert.equal(detectForge("git@ado-work:v3/contoso/Web%20Shop/api", { hosts })?.organizationUrl, "https://dev.azure.com/contoso");
  // Bitbucket Cloud through an alias.
  assert.deepEqual(detectForge("git@bb-work:team/app.git", { hosts }), { forge: "bitbucket", source: "host-mapping", workspace: "team", repo: "app", slug: "team/app", webUrl: "https://bitbucket.org/team/app" });
  // Unmapped hosts stay unknown, and a mapping needs the forge's path shape.
  assert.equal(detectForge("git@gitlab-work:acme/widgets.git", { hosts }), null);
  assert.equal(detectForge("https://github.example.com/acme", { hosts }), null);
  // Built-in hosts are detected as before when mappings exist.
  assert.equal(detectForge("https://github.com/acme/widgets.git", { hosts })?.source, "detected");
});

test("a project's forge override wins over detection and custom hosts", () => {
  const hosts = [{ match: "git.corp.example", forge: "github", host: "" }];
  // Unknown host: the override decides.
  assert.deepEqual(detectForge("https://code.corp.example/tfs/Main/Tools/_git/cli", { override: "azure-devops" }), {
    forge: "azure-devops", source: "project-override", organization: "Main", organizationUrl: "https://code.corp.example/tfs/Main", project: "Tools", repo: "cli",
    slug: "Main/Tools/cli", webUrl: "https://code.corp.example/tfs/Main/Tools/_git/cli",
  });
  assert.deepEqual(detectForge("git@git.corp.example:team/app.git", { hosts, override: "bitbucket" }), { forge: "bitbucket", source: "project-override", workspace: "team", repo: "app", slug: "team/app", webUrl: "https://bitbucket.org/team/app" });
  // It wins over a built-in host too.
  assert.equal(detectForge("https://github.com/acme/widgets.git", { override: "github" })?.source, "project-override");
  // A path that doesn't fit the overriding forge is still unknown.
  assert.equal(detectForge("https://code.corp.example/a/b/c", { override: "github" }), null);
  // Windows paths are never a host.
  assert.equal(detectForge("C:\\repos\\widgets", { override: "github" }), null);
});

test("Azure DevOps Server keeps its scheme and port, and reads the project-named short form", () => {
  const hosts = [{ match: "tfs.corp", forge: "azure-devops", host: "" }, { match: "tfs-ssh", forge: "azure-devops", host: "http://tfs.corp:8080" }];
  const server = (url, options = { hosts }) => detectForge(url, options);
  // http and a non-default port are kept, in the organization URL and the web URL.
  assert.deepEqual(server("http://tfs.corp:8080/tfs/DefaultCollection/Proj/_git/Repo"), {
    forge: "azure-devops", source: "host-mapping", organization: "DefaultCollection", organizationUrl: "http://tfs.corp:8080/tfs/DefaultCollection", project: "Proj", repo: "Repo",
    slug: "DefaultCollection/Proj/Repo", webUrl: "http://tfs.corp:8080/tfs/DefaultCollection/Proj/_git/Repo",
  });
  // The short form: <collection>/_git/<repo>, with the project named like the repository.
  const short = server("http://tfs.corp:8080/tfs/DefaultCollection/_git/Repo");
  assert.deepEqual([short.organization, short.organizationUrl, short.project, short.repo], ["DefaultCollection", "http://tfs.corp:8080/tfs/DefaultCollection", "Repo", "Repo"]);
  // Azure DevOps Server 2019 and later have no /tfs: the first segment is the collection.
  const modern = server("https://tfs.corp/Main/Web/_git/api");
  assert.deepEqual([modern.organization, modern.organizationUrl, modern.project, modern.repo], ["Main", "https://tfs.corp/Main", "Web", "api"]);
  const modernShort = server("https://tfs.corp/Main/_git/api");
  assert.deepEqual([modernShort.organizationUrl, modernShort.project, modernShort.repo], ["https://tfs.corp/Main", "api", "api"]);
  // A default port isn't repeated.
  assert.equal(server("https://tfs.corp:443/tfs/DefaultCollection/Proj/_git/Repo").organizationUrl, "https://tfs.corp/tfs/DefaultCollection");
  // An SSH remote gets its web address from the mapping, scheme and port included.
  const ssh = server("ssh://git@tfs-ssh:22/tfs/DefaultCollection/Proj/_git/Repo");
  assert.equal(ssh.organizationUrl, "http://tfs.corp:8080/tfs/DefaultCollection");
  assert.equal(ssh.webUrl, "http://tfs.corp:8080/tfs/DefaultCollection/Proj/_git/Repo");
  // The same through a project override, with no custom host.
  assert.equal(server("http://tfs.other:8080/tfs/Coll/P/_git/R", { override: "azure-devops" })?.organizationUrl, "http://tfs.other:8080/tfs/Coll");
  // Shapes that aren't a Server repository stay unknown.
  assert.equal(server("http://tfs.corp:8080/tfs/DefaultCollection/Proj/Repo"), null);
  assert.equal(server("http://tfs.corp:8080/tfs/DefaultCollection"), null);
  // A GitHub Enterprise server on its own port keeps it, for gh and the web.
  const ghe = detectForge("http://ghe.corp:8443/acme/widgets.git", { hosts: [{ match: "ghe.corp", forge: "github", host: "" }] });
  assert.deepEqual([ghe.host, ghe.slug, ghe.webUrl], ["ghe.corp:8443", "ghe.corp:8443/acme/widgets", "http://ghe.corp:8443/acme/widgets"]);
});
