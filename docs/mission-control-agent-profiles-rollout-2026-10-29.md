# Mission Control agent profile rollout — 2026-10-29

The approved host profile setup is installed on Personal and all eight remote hosts. This records the configuration rollout, not completion of an application task or an end-to-end intake-to-PR run.

## Active host defaults

All hosts default to one independent reviewer. The second reviewer is configured but runs only when two reviews are selected. Plan, build and review profiles use high reasoning; validation uses medium reasoning.

| Host | Provider | Plan | Build | Validate | Review | Optional second review |
| --- | --- | --- | --- | --- | --- | --- |
| Personal | Codex; Claude for review | Astra | Sol 6.1 | Sol 6.1 | Opus 5.5 | Codex Astra |
| CNS | Direct GitHub Copilot | Astra | Sol 6.1 | Sonnet 5.5 | Opus 5.5 | Astra |
| AACN | Codex; OpenCode/Copilot for second review | Astra | Sol 6.1 | Sol 6.1 | Astra | Copilot Sonnet 5.5 |
| PN | Codex | Astra | Sol 6.1 | Sol 6.1 | Astra | Sol 6.1 |
| WestCap | Claude Code | Fable 5.1 | Opus 5.5 | Opus 5.5 | Fable 5.1 | Opus 5.5 |
| Chipotle | Direct GitHub Copilot | Astra | Sol 6.1 | Sonnet 5.5 | Opus 5.5 | Astra |
| CareSource | Direct GitHub Copilot | Opus 5.5 | Sol 6.1 | Sonnet 5.5 | Opus 5.5 | Sol 6.1 |
| Xendee | Claude Code | Fable 5.1 | Opus 5.5 | Opus 5.5 | Fable 5.1 | Opus 5.5 |
| JCI | OpenCode / JCI Bedrock gateway | JCI Opus 5.5 | JCI Sol 6.1 | JCI Sol 6.1 | JCI Opus 5.5 | JCI Sol 6.1 |

JCI's exact primary model IDs are `amazon-bedrock/us.anthropic.claude-opus-5-5` and `amazon-bedrock/us.openai.gpt-6.1-sol`. Both were verified against the live JCI-labelled catalogue entries. AACN's Copilot route is `opencode/github-copilot/claude-sonnet-5.5`; direct Copilot was not advertised on that host.

## Alternatives and manual backups

- Personal: Fable 5.1 planning and Opus 5.5 building alternatives. No OpenCode profiles.
- AACN: Copilot Sonnet 5.5 through OpenCode. The live OpenCode catalogue did not advertise the requested Copilot Sol 6.1, so no older Sol version was substituted.
- WestCap and Xendee: Codex Astra and Sol 6.1, including a medium-reasoning validation variant.
- CareSource: Claude Opus 5.5, including a medium-reasoning validation variant. No Astra or Fable was assigned.
- JCI: first backup is Copilot through OpenCode, using Astra, Sol 6.1 and Sonnet 5.5. Final backup is `opencode-go/deepseek-v4-pro` with high reasoning; that model does not advertise medium reasoning.
- PN: Codex only; Claude remains a future addition.
- CNS: no routine Codex fallback, preserving the user's five-hour limit budget.

Fallbacks require an explicit profile/mapping selection. This rollout does not implement automatic quota detection or provider switching. If only one distinct model remains available, use one-review policy rather than counting two runs of the same underlying model as independent model reviews.

## Instructions and permissions

Profiles reference the task-bound workflow skills and require approved scope, existing patterns, minimal maintainable changes, preservation of user edits, and honest validation evidence. Review profiles reference `review-changes` and `open-code-review-delegate`: OCR determines files and rules; the selected model performs the review in a fresh session with Gortex context.

Native permission modes are Codex `auto`, Claude `auto`, Copilot's normal ACP Agent mode, and OpenCode `build`. Tool/path permissions may still require approval; the CNS pilot needed one-time permission for its read-only shell probes. These profiles do not enable bypass or allow-all modes.

Plan and code approval remain separate from approval to publish, open a draft PR, post tracker updates, merge, deploy, or change production. Existing authorization for a specific action still applies.

## Existing tasks

The host defaults are used by future Mission Control managed phase launches when no project or task override takes precedence. Running agents keep their current model and permissions. Existing tasks, plans, decisions, evidence, and project/task overrides were not rewritten. Manual agent creation does not automatically become a managed pipeline stage merely because a profile is selected.

Sixty new native profiles were added across nine hosts. Personal's eight existing profiles were preserved. No reverse registration of Personal on remote hosts was created.

## Verification performed

- All nine hosts were online and exposed the required native model IDs, modes, and reasoning options.
- Every host's native profiles and Mission Control host policy were read back after saving. All nine effective policies resolved without a problem.
- Personal Codex/Astra pilot `330ec534-d453-4d64-a4f6-920d1fedc094` started with the configured mode and high reasoning, read the plan/execute skills, and confirmed approval and scope boundaries.
- Personal Claude/Opus pilot `4683a407-355c-4b1a-8cf8-8a3f0f718d2f` loaded both review skills, ran OCR 1.13.3, and confirmed Gortex MCP was mounted.
- CNS direct Copilot/Opus pilot `9d0eb142-eb10-46a4-8378-81392d9cd660` loaded both review skills, ran OCR 1.12.9, and confirmed Gortex MCP was mounted.
- Both reviewer pilots found the Gortex CLI; the probe used unsupported `gortex --version`, so it did not establish an exact version. Host setup inventory reported Gortex 0.64.11. The supported CLI command is `gortex version`.
- `node --test server/stage-launch.test.mjs` passed all three tests: selected profile and parent/task/run preservation; safe failed worker creation; review refusal on OCR failure or changed candidate fingerprint.
- No application code, plan approval, review verdict, PR, or external tracker update was produced by the pilots. A complete real-task lifecycle and every model/backup combination were not exercised.

Personal's Claude installation was missing eleven workflow/OCR skill links and four OCR rule files. These were created through Mission Control's guarded setup operations. Existing user-managed skills and rules on other hosts were preserved. Installed OCR versions newer than the kit's 1.12.9 pin were not downgraded despite the setup screen labelling any version difference as outdated.

## Rollback and evidence

Configuration snapshots are stored locally under:

`C:\Users\n_var\AppData\Local\MissionControl\profile-rollouts\2026-10-29`

Each host has `-before.json` (original native profiles and policy), `-prepared.json` (new profile definitions and mapping), and `-after.json` (verified native profiles and effective policy). These snapshots omit credentials and full daemon configuration. Restore only the affected profile entries and host policy through Paseo/Mission Control APIs, preserving changes made after this rollout; do not blindly replace daemon configuration.

Fresh inventory and setup plans are in `C:\Users\n_var\AppData\Local\Temp\mc-profile-rollout-20261029`. The approved proposal remains in [mission-control-agent-profiles-proposal.md](mission-control-agent-profiles-proposal.md).
