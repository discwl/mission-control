# Install Mission Control on a host

Mission Control is a trusted Paseo plugin plus a workflow kit. Paseo's Git installation downloads the complete repository and selects its plugin subfolder, keeping the workflow skills, scripts, OCR rules and guide at the same revision. You do not need to clone the repository manually.

Before installing on a host, check that Paseo's **Enable plugins** switch is on, that Node.js, npm and Git are available to the daemon, and which coding providers have quota there. Agree on the delivery mode, branch names and what agents may do before review first, so configuration takes one pass.

## Prerequisites and repository access

This kit currently targets Windows and uses the fixed vault location `C:\dev-vault`; configurable vault roots and other operating systems are not implemented. Use Node.js 22 or newer, npm, Git, and a running Paseo daemon with a version compatible with `plugins/mission-control/paseo-plugin.json`. Configure at least one supported coding provider on the host. Run installation as the same operating-system account that runs Paseo.

`discwl/mission-control` is public. Cloning it and pulling updates over HTTPS do not require a GitHub token. Publishing changes still requires authenticated write access.

If you use a private fork, give the host access to that fork. For a fine-grained GitHub personal access token, select only the fork's repository with **Contents: Read-only**, and set an expiration. One token can work on multiple hosts; separate tokens let you revoke a single host. GitHub also grants the required metadata read access. Store the token in Git Credential Manager or the host's credential store. Keep it out of clone URLs, repository files, scripts, logs and agent prompts. SSH keys are another option. See [GitHub's PAT guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

## Install from GitHub

In Paseo, choose the intended host and turn on **Settings → Plugins → Enable plugins** if it is off. This is the daemon's global switch; an automated installer should inspect the current value and obtain explicit authorization before enabling it on an existing host. See [Paseo's plugin quickstart](https://paseo.sh/docs/plugins). An installed plugin can report enabled but remain disabled while this global switch is off.

Run this on the target Windows host:

```powershell
paseo plugin add git:https://github.com/discwl/mission-control.git:plugins/mission-control --ref master
paseo plugin ls --json
```

Use the explicit `git:` source shown. Paseo 0.11.1 reads the shorter `discwl/mission-control:plugins/mission-control` as a Paseo registry source and refuses it. The `git:` form also records the Git identity that updates need. Paseo downloads the repository and runs the manifest's dependency preparation before loading the plugin. Node.js, npm and Git must be available to the daemon. The preparation includes development dependencies because Paseo's client boundary check needs the SDK type definitions; npm lifecycle scripts are disabled. Confirm `mission-control` is enabled and `running`.

You can also select the target host in **Settings → Plugins**, enter `git:https://github.com/discwl/mission-control.git:plugins/mission-control` as Plugin source, and choose **Install plugin**. To issue the command from another machine, replace `HOST_ENDPOINT` with the reachable daemon endpoint already configured for that host:

```powershell
paseo plugin add git:https://github.com/discwl/mission-control.git:plugins/mission-control --ref master --host "HOST_ENDPOINT"
paseo plugin ls --host "HOST_ENDPOINT" --json
```

The download and preparation run on the selected daemon host. Public GitHub access needs no token. Use `--home` instead when selecting a separate local daemon home.

The installed `path` in `paseo plugin ls --json` ends with `checkout\plugins\mission-control`. That checkout is replaced by every update, so don't use it as `kitRoot` directly. Mission Control keeps a stable link to the current install at `%USERPROFILE%\.paseo\plugin-data\mission-control\kit` (under `PASEO_HOME` when that is set) and re-points it on every start. Use that link as the workflow `kitRoot`; Setup's **Stable kit path → Use it…** moves existing profiles onto it. The path belongs to the daemon host, even when the command runs remotely.

### Optional local checkout

For development or a checkout you manage yourself, the original directory installation also works. Run these from a stable parent directory on the target host:

```powershell
git clone https://github.com/discwl/mission-control.git
Set-Location .\mission-control
npm --prefix .\plugins\mission-control ci
npm --prefix .\plugins\mission-control run typecheck
paseo plugin install .\plugins\mission-control --json
paseo plugin ls --json
```

A directory installation stays linked to that checkout, so keep it available. Its `kitRoot` is the manually cloned repository root. The commands above target the local default daemon.

These instructions target Windows hosts. Paseo itself supports other platforms, but this workflow kit's fixed Windows vault and path assumptions need portability work before installing it on Linux or macOS.

## Configure this host

1. Open **Mission Control → Docs → Set up Obsidian → Initialize vault** if this host has no vault. This creates `C:\dev-vault` and its Obsidian settings, but does not create host identity or workflow profiles. There is currently no vault-root selector. Keep operational vault records and credentials outside the repository.
2. Create missing `Projects` and `Tasks` folders beneath that vault. Configure `host.json` with `schemaVersion: 1`, the actual daemon `serverId`, and this host's stable adapter `hostId`. Never copy another host's identity or example IDs. Preserve existing task records and assignments.
3. Create or update one project profile per intended Paseo project ID in the vault's `Projects` folder. Use a lowercase filename with letters, digits, hyphens or underscores and a `.md` extension. Its frontmatter must contain `schemaVersion: 1`, the actual `projectId`, the same `hostId` as `host.json`, the absolute application's `repository` path, and an absolute `kitRoot` pointing to this checkout's root containing both `skills` and `scripts/dev-flow.mjs`. Keep any existing additional fields for validation, tracker and delivery, and configure them for the intended project. There is no project-profile template shipped in this checkout; reconcile a known working profile when one is available. Workspaces and task assignments use their actual Paseo IDs. Keep one consistent workflow kit root per host; conflicting kit roots disable Setup's skill/rule actions.
4. Initialize the enabled coding providers so their skill directories exist. Use Setup to inspect and install or synchronize the workflow skills and OCR delegation skill. Review its planned changes before replacing existing configuration.
5. Use Setup to confirm the pinned OCR CLI **1.12.9** and the kit's review rules. Install required tools for the projects and forges used by this host. Keep tracker and forge credentials in their supported local credential configuration.
6. Configure this host's tracker as **Jira or Azure DevOps**, with the intended project and import scope. Verify credentials and project selection before importing real work. Open **Settings → Plugins → Mission Control → Workflow instructions** to save host Intake/Planning defaults and any project overrides. Include clarification preferences and Confluence/database references for that host; tool connections and credentials remain separate. The effective preview shows the combined guidance. See [Workflow instructions](workflow-instructions.md).
7. Confirm the plugin's validation commands, delivery policy and provider settings for the application project. Saved Paseo profiles and native schedules are optional configuration; installation does not create them.
8. On a host where you attend meetings, configure the chosen meeting app **Talat** to export Markdown into `C:\dev-vault\Meetings\Talat` using its [Obsidian integration](https://talat.app/docs/integrations/obsidian). Follow the [meeting workflow](meeting-capture-vault-workflow.md) and verify one finished meeting reaches the vault. This is optional host setup; plugin installation does not configure Talat or implement meeting-to-task ingestion.

If an existing vault or project profile is already configured, reconcile it with this host rather than resetting it. Read Setup's diagnostics before changing configuration. `kitRoot` is the workflow checkout; the application's repository root is a different setting.

## Smoke check

Open a disposable agent in an intended workspace. Confirm its Review bubble opens the main workspace Review tab with one press, and that closing or switching tabs stays put. Check the workspace and native-chat Needs you surfaces with a disposable question; answer once and confirm the waiting card clears. Use a prepared test task to verify exact host/project/workspace assignment, launch/resume and the human review handoff. Stop before real merge, deployment or tracker updates unless those actions are authorized.

Run the application project's own validation commands for that test task. Plugin typecheck verifies plugin types; it does not validate the application or establish that a task is delivered. The [user guide](user-guide/mission-control-user-guide.html) explains the current workflow, and the [roadmap](mission-control-factory-roadmap.md) distinguishes planned coordination and forecasting from current features.

## Update an installed host

For a Paseo-managed Git installation, check and apply the repository update:

```powershell
paseo plugin update mission-control --check
paseo plugin update mission-control --yes
paseo plugin ls --json
```

An update installs into a new folder and removes the old one. Profiles and skill links on the stable kit path keep working, because Mission Control re-points the link when it starts, and agents running from that path keep working too. A profile still naming one install's folder breaks: open Setup, choose **Stable kit path → Use it…**, then update the skill links it lists. Check the OCR rules as well. Use the same `--host` or `--home` selection consistently for another daemon.

For a directory installation, update your own checkout with local changes accounted for:

```powershell
git pull --ff-only
npm --prefix .\plugins\mission-control ci
npm --prefix .\plugins\mission-control run typecheck
paseo plugin reload mission-control --json
paseo plugin ls --json
```

Keep your own checkout path stable so installed skill links and project profiles remain valid. Resolve Git failures without discarding local changes.

## Short agent prompt for a new host

Copy this on the intended Windows host; public repository read access needs no token:

> Install Mission Control on the intended Windows host using `paseo plugin add git:https://github.com/discwl/mission-control.git:plugins/mission-control --ref master` and the repository's docs/install-mission-control.md. Check the target daemon's global Enable plugins switch and verify the installation reports running; obtain explicit authorization before enabling the global switch on an existing host if it is off. Paseo downloads the complete checkout and prepares the dependencies, so no manual clone is required. Read the installed path from `paseo plugin ls --json` and use its checkout root as kitRoot on that host. Inspect the actual host, project and workspace IDs and the fixed Windows vault at C:\dev-vault before configuring anything. Reconcile the intended project profiles, configure this host's Jira or Azure DevOps project and its Workflow instructions (host Intake/Planning defaults and project overrides, using context the user supplies rather than guessing), and verify provider skills, OCR 1.12.9 and review rules through Setup. Preserve existing configuration and task records; never print or store credentials in the repository. Ask for missing host-specific information only when needed. Verify Review navigation and Needs you using disposable test work, stop at human review, and report what passed or remains blocked. After Git updates, reconcile any changed kitRoot and skill links. Leave schedules, real merges and deployments inactive unless separately authorized.
