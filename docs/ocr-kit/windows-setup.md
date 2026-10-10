# OCR + Gortex review in Paseo: Windows setup

Research snapshot: **16 September 2026**. Verified release targets: OCR **1.12.3**, Paseo **0.8.0**, Gortex **0.64.3**. Start with a new agent in your existing workspace. No Paseo plugin, API key, extra orchestrator or automated repair loop is needed.

The PowerShell commands below are for the **Windows machine/account running the Paseo daemon and provider CLIs**. If your Paseo host runs in WSL, a container or on another machine, its home, PATH, Git root and Gortex daemon are different: install there using that platform's paths. Windows UI access does not make Windows-installed tools available inside WSL.

## 1. Verify the existing tools and install OCR

Use PowerShell, preferably PowerShell 7. Git for Windows and a supported Node.js LTS should already be installed. OCR itself declares Node >=14, but that is a package minimum, not a recommendation to install an obsolete Node release.

```powershell
git --version
node --version
npm --version
npm install -g @alibaba-group/open-code-review@1.12.3
ocr --version
ocr delegate preview --help
```

Do not configure an OCR provider or enter an API key. Both delegation commands work without one. Avoid the ordinary `ocr review`/`ocr scan` workflow for this setup. [OCR delegation instructions](https://github.com/alibaba/open-code-review/blob/v1.12.3/skills/open-code-review-delegate/SKILL.md)

Find the actual installation instead of assuming a drive:

```powershell
npm prefix -g
npm root -g
Get-Command ocr -All
where.exe ocr
```

The usual Windows npm command shim is `%APPDATA%\npm\ocr.cmd`; the native executable lives in npm's platform package or the OCR package's `bin` fallback. The prefix can differ with your Node installation. If PowerShell blocks an npm `.ps1` shim, use `npm.cmd` / `ocr.cmd`; do not change execution policy just for this. Restart Paseo after changing PATH so its daemon can see the CLI. [Launcher/platform source](https://github.com/alibaba/open-code-review/blob/v1.12.3/scripts/platform.js)

Paseo Desktop already bundles its daemon. If it is not installed, use the [Windows desktop download](https://paseo.sh/download); do not start a second daemon unnecessarily. The optional CLI is `npm install -g @getpaseo/cli@0.8.0`.

Confirm at least one provider CLI works in the same account:

```powershell
Get-Command codex, claude -ErrorAction SilentlyContinue
```

For Codex, use `codex login` and select ChatGPT authentication. For Claude, open `claude` and use its normal subscription sign-in. If already signed in, preserve it. Paseo uses the official CLIs; its Claude Agent SDK integration does not require a separate credit pool. These reviews consume the normal subscription allowance. An API-key-authenticated provider session still bills its API account. [Paseo Codex](https://github.com/getpaseo/paseo/blob/v0.8.0/public-docs/codex.md), [Paseo Claude](https://github.com/getpaseo/paseo/blob/v0.8.0/public-docs/claude-code.md)

## 2. Install the upstream delegation skill globally

Choose the **delegation** skill, not the API-driven OCR skill. The upstream installer is:

```powershell
npx skills add alibaba/open-code-review --skill open-code-review-delegate
```

Choose global installation and the hosts you actually use. For a reproducible installation without installer prompts, the equivalent pinned single-file skill is:

```powershell
$SkillUrl = 'https://raw.githubusercontent.com/alibaba/open-code-review/v1.12.3/skills/open-code-review-delegate/SKILL.md'
$ClaudeSkill = Join-Path $env:USERPROFILE '.claude\skills\open-code-review-delegate'
$CodexSkill = Join-Path $env:USERPROFILE '.agents\skills\open-code-review-delegate'
New-Item -ItemType Directory -Force $ClaudeSkill, $CodexSkill | Out-Null
Invoke-WebRequest -Uri $SkillUrl -OutFile (Join-Path $ClaudeSkill 'SKILL.md')
Copy-Item (Join-Path $ClaudeSkill 'SKILL.md') (Join-Path $CodexSkill 'SKILL.md') -Force
```

Use **one** installation method. The pinned download above replaces that exact skill's existing file; preserve your own edits first if you previously customized it. It does not install a Work Mode personal skill into this conversation; it installs the ordinary provider skill on your Windows host.

Start a new provider session after installation. In Claude, check that `/open-code-review-delegate` is available. In Codex, use the skill picker or explicitly ask it to load `open-code-review-delegate`; slash-command presentation can differ by host. Ask it to state the loaded skill's full path. Paseo's SDK also exposes `agent.commands()` to inspect the commands/skills the session actually loaded. [Paseo session commands](https://github.com/getpaseo/paseo/blob/v0.8.0/public-docs/sdk/agents.md)

## 3. Install the C# rule and reusable prompt

Extract the supplied kit to, for example, `%USERPROFILE%\Downloads\ocr-paseo-gortex-kit`. Adjust `$Kit` if you saved it elsewhere:

```powershell
$Kit = Join-Path $env:USERPROFILE 'Downloads\ocr-paseo-gortex-kit'
$OcrHome = Join-Path $env:USERPROFILE '.opencodereview'
$RuleDirectory = Join-Path $OcrHome 'rules'
New-Item -ItemType Directory -Force $RuleDirectory | Out-Null
Copy-Item (Join-Path $Kit 'csharp-dotnet.md') (Join-Path $RuleDirectory 'csharp-dotnet.md') -Force
Copy-Item (Join-Path $Kit 'reviewer-prompt.md') (Join-Path $OcrHome 'reviewer-prompt.md') -Force
Copy-Item (Join-Path $Kit 'review-output.schema.json') (Join-Path $OcrHome 'review-output.schema.json') -Force

$RuleConfig = Join-Path $OcrHome 'rule.json'
if (-not (Test-Path $RuleConfig)) {
    Copy-Item (Join-Path $Kit 'global-rule.json') $RuleConfig
} else {
    Write-Host "Existing rule configuration: $RuleConfig. Merge the entry described below."
}
```

For an existing configuration, retain its settings and add this entry **before broader matching rules** in its `rules` array:

```json
{
  "path": "**/*.{cs,csx,cshtml,razor,csproj,props,targets}",
  "rule": "rules/csharp-dotnet.md",
  "merge_system_rule": false
}
```

Also merge `**/*.{csx,cshtml,razor,csproj,props,targets}` into `include`, and `**/bin/**`, `**/obj/**` into `exclude`. The supplied complete configuration already does this. These extra extensions need inclusion because OCR's built-in extension list does not include them. `include` is an eligibility override, not a whitelist; TypeScript, SQL, JSON and other normally supported files still participate. C# files under migrations and tests remain eligible.

The effective paths are:

| Purpose | Windows path |
|---|---|
| Global rule configuration | `%USERPROFILE%\.opencodereview\rule.json` |
| C#/.NET rule body | `%USERPROFILE%\.opencodereview\rules\csharp-dotnet.md` |
| Reusable assignment | `%USERPROFILE%\.opencodereview\reviewer-prompt.md` |
| Optional structured output schema | `%USERPROFILE%\.opencodereview\review-output.schema.json` |

No global `config.json` is necessary for delegation. Preserve one if you already use managed OCR. JSON must be UTF-8 without a BOM; copying the supplied file preserves its encoding. Windows PowerShell 5's `Out-File -Encoding utf8` adds a BOM, so do not use it to recreate OCR JSON. [Rule resolver](https://github.com/alibaba/open-code-review/blob/v1.12.3/internal/config/rules/system_rules.go)

**Precedence matters:** command `--rule` > repository `.opencodereview/rule.json` > global > built-in. A matching project rule can replace the global C# rule. Include/exclude arrays are taken from the highest-priority layer containing either array, not merged across all layers. A project's filter settings can therefore hide the global extra-extension include. Repeat those includes in that project's configuration if needed.

For Angular/React reviews, inspect excluded test files. To intentionally include changed frontend tests, add `**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}` and `**/__tests__/**/*.{ts,tsx,js,jsx,mjs,cjs}` to the effective layer's `include`. They are omitted from the minimal global .NET configuration to avoid silently changing your frontend review policy.

## 4. Verify rule resolution and branch scope

Run inside your **actual Paseo workspace/worktree**, not automatically the primary checkout. Replace the example path with that directory:

```powershell
Set-Location 'C:\src\MyApp'
$RepoRoot = (git rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0) { throw 'This directory is not a Git worktree.' }
git --no-pager status --short
git branch --show-current
git rev-parse --verify 'main^{commit}'
```

If your default branch is elsewhere, specify it deliberately. For a fresh remote comparison, run `git fetch origin` yourself and choose `origin/main`; do not assume local `main` is current. Branch review only sees committed branch changes. Finish your normal commit workflow first, or explicitly request a separate workspace review.

Use any representative path ending in `.cs`; rule checking does not require the file to exist:

```powershell
ocr rules check --repo $RepoRoot 'src/Example.cs'
$RuleJson = & ocr delegate rule --repo $RepoRoot --format json 'src/Example.cs' 'src/Example.csproj'
if ($LASTEXITCODE -ne 0) { throw 'OCR rule resolution failed.' }
$ResolvedRules = ($RuleJson -join "`n") | ConvertFrom-Json
$ResolvedRules.groups | Select-Object source, pattern, files
$ResolvedRules.groups[0].rule
```

Expect `source: global`, the `**/*.{cs,...}` pattern and the **C# and .NET correctness review** text. If it says `project` or `custom`, inspect that override; if it says `system` and generic rules, fix configuration before reviewing.

Freeze the branch endpoints and inspect the review manifest:

```powershell
$BaseSha = (git rev-parse --verify 'main^{commit}').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve main.' }
$HeadSha = (git rev-parse --verify HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve HEAD.' }
$PreviewJson = & ocr delegate preview --repo $RepoRoot --from $BaseSha --to $HeadSha --format json
if ($LASTEXITCODE -ne 0) { throw 'OCR preview failed.' }
$Preview = ($PreviewJson -join "`n") | ConvertFrom-Json
$Preview | Select-Object mode, repository, from, to, merge_base, total_files, reviewable_count, excluded_count
$Preview.reviewable_files | Format-Table path, status, insertions, deletions
$Preview.excluded_files | Format-Table path, status, exclude_reason
```

The preview is not a review; no model has evaluated the code yet. For an explicit workspace-scope test, use `ocr delegate preview --repo $RepoRoot --format json` without range flags. It includes tracked modifications and untracked files. The two scopes are not interchangeable.

## 5. Keep the existing Gortex setup and check it

If Gortex is already working, start with diagnostics:

```powershell
gortex version
gortex doctor
gortex daemon status
gortex repos families
gortex repos explain-view $RepoRoot --format json
```

For a new installation, use Gortex's [Windows installation instructions](https://github.com/zzet/gortex#installation) or [0.64.3 release binaries](https://github.com/zzet/gortex/releases/tag/v0.64.3). Its published PowerShell bootstrap is `irm https://get.gortex.dev/install.ps1 | iex`; run it only for a new installation, then verify the installed version. The standard commands for host/provider setup are:

```powershell
gortex install --agents=claude-code,codex
gortex init --agents=claude-code,codex --yes
```

`install` writes user-level provider configuration; `init` writes repository integration files. Inspect existing generated files rather than rerunning setup in every Paseo worktree. Track the **primary checkout once** if it is not already tracked:

```powershell
gortex track 'C:\src\MyApp' --wait --wait-timeout 10m
```

Use the real primary checkout path above. For a linked worktree in a known Git family, allow automatic discovery; do not use `--as-worktree` merely to silence an indexing wait. Do not hard-code the primary checkout into every MCP command using `--index`. The normal MCP entry is `gortex mcp`, which routes to a shared daemon using the calling context. [Gortex agents](https://github.com/zzet/gortex/blob/v0.64.3/docs/agents.md), [worktree commands](https://github.com/zzet/gortex/blob/v0.64.3/docs/cli.md)

Keep your chosen deny mode. Claude's default hook mode is deny; Codex's default is advisory/enrich. If you intentionally want to enable Codex deny mode, the documented PowerShell equivalent is:

```powershell
$env:GORTEX_CODEX_HOOK_MODE = 'deny'
gortex init --agents=codex --hooks-only
Remove-Item Env:GORTEX_CODEX_HOOK_MODE
```

Do not run that block just to get the first review working. Codex hook declarations must be trusted in the host's `/hooks` UI; a configuration file alone does not establish that hooks run. Check `gortex doctor` and the actual Paseo session. If hooks work in standalone Codex but not its Paseo session, record the integration gap; do not assume enforcement.

For the first trial, prefer a committed branch review. Untracked-file review can conflict with source-read deny rules; the supplied prompt reports that gap instead of bypassing the hook.

## 6. Launch a fresh Paseo reviewer

In Paseo, stay in the workspace where you finished the branch and create a **new agent**. Select Claude or Codex using its existing subscription authentication. Keep Gortex MCP enabled for that provider and confirm the tool list contains its context tools. A new agent is a clean conversation; no extra worktree is needed for this read-only phase.

Optional convenience: **Settings → your host → Agents → Agent profiles → New profile**, name it `OCR Reviewer`, select the provider/model and suitable reasoning level. Use read-only permissions where the provider exposes them, while retaining shell access for Git/OCR and Gortex read tools. A planning-only mode that forbids required shell commands is unsuitable. Put `Independent read-only OCR delegation review with Gortex context` in **When to use**. Those notes help profile selection; they do **not** inject the review assignment. [Profiles](https://github.com/getpaseo/paseo/blob/v0.8.0/public-docs/agent-profiles.md)

Paste this daily command into that new agent, replacing the Windows username/path if necessary:

> Read `%USERPROFILE%\.opencodereview\reviewer-prompt.md` from my Windows user home and follow it. Review this branch against `main` with `open-code-review-delegate`. Use Gortex for repository context. Apply the resolved global C#/.NET rule. Do not modify code. Return high-confidence findings, actual Gortex evidence, exclusions and complete review coverage.

The agent should resolve the Windows home variable to a real path; pasting the full path is even more reliable. You can instead paste the entire `reviewer-prompt.md` body.

Optional CLI launch in the same workspace:

```powershell
paseo workspace ls
$WorkspaceId = 'paste-the-existing-workspace-id'
$ReviewPrompt = Get-Content -Raw (Join-Path $env:USERPROFILE '.opencodereview\reviewer-prompt.md')
paseo run --workspace $WorkspaceId --provider claude $ReviewPrompt
```

For Codex, replace `claude` with `codex`. A bare `paseo run` from a human shell creates a new local workspace, so retain `--workspace`. There is no verified `--profile` flag here. With the optional schema:

```powershell
paseo run --workspace $WorkspaceId --provider codex --output-schema (Join-Path $env:USERPROFILE '.opencodereview\review-output.schema.json') $ReviewPrompt
```

Do not combine `--output-schema` with `--background`; Paseo disallows that combination. The initial UI/pasted-prompt path does not need the schema flag. [Paseo CLI](https://github.com/getpaseo/paseo/blob/v0.8.0/public-docs/cli.md)

## Confirm that it worked

The transcript should show both OCR delegation commands, actual Git diff retrieval and at least one relevant Gortex context call. Inspect that call's selected checkout/freshness and compare a changed symbol with the reviewed SHA. The report should identify the global rule, distinguish excluded files from reviewed files and have an explicit coverage entry for every previewed reviewable row. No OCR LLM provider was needed.

If the Gortex graph is unavailable or wrong-worktree, a “clean” findings array is not success. If there are no committed changes against main, choose a branch with changes or request workspace review; do not infer correctness from empty scope. No local setup can prove the model found every bug.

## What was tested for this kit

OCR 1.12.3 was executed against a disposable Git repository on Linux, without an OCR LLM configuration. The supplied rule file/configuration resolved correctly; `.csproj` inclusion, build-output exclusion, branch/workspace differences, staged additions, untracked additions and default test/deletion exclusions were checked. Rule precedence/filter behavior was verified against source and additional fixture checks. This is not a native Windows/Paseo/Gortex end-to-end execution or a measured C# defect-detection benchmark. The commands above include the checks you should perform on your own host.
