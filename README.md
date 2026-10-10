# Mission Control

Mission Control is a local Paseo plugin and Development Flow workflow kit for coordinating application work across hosts, projects, workspaces and agents. It provides task launch/resume, Needs you questions and decisions, workspace Review, file actions, delivery controls, and a standalone user guide.

- [Install on a new host, including the setup agent prompt](docs/install-mission-control.md)
- [User guide](docs/user-guide/mission-control-user-guide.html) — download/open the standalone HTML for its interactive navigation and embedded screenshots.
- [Current snapshot and factory roadmap](docs/mission-control-factory-roadmap.md)
- [Plugin reference](plugins/mission-control/README.md)
- [Workflow and task bridge](docs/agent-workflow.md)

Install the complete repository so `plugins/mission-control`, `skills`, `scripts/dev-flow.mjs` and `docs/ocr-kit` stay together. A host's project profiles point `kitRoot` at this checkout. Each host uses Jira or Azure DevOps; operational vault records and credentials stay on that host.

## Current scope

The plugin supports supervised work and human review. Scheduled host coordinators, cross-host supervision, sprint forecasting and the full autonomous factory remain roadmap work. Installation does not enable schedules or authorize merges or deployments.

## Development checks

Requires Node.js 22 or newer. From the repository root:

```powershell
npm --prefix .\plugins\mission-control ci
npm --prefix .\plugins\mission-control run typecheck
node --experimental-strip-types --test --test-concurrency=2 plugins/mission-control/client/*.test.mjs plugins/mission-control/server/*.test.mjs plugins/mission-control/shared/*.test.mjs
node --test scripts/dev-flow.test.mjs
npm --prefix .\plugins\mission-control audit
```

The Git integration tests create disposable local repositories. Their duration depends on the host; allow them to finish and inspect individual failures rather than treating an imposed time limit as a passing result.

Third-party notices are in [THIRD_PARTY_NOTICES.md](plugins/mission-control/THIRD_PARTY_NOTICES.md), including Agent Crew's MIT notice and the [Paseo icons license](plugins/mission-control/third-party/paseo-icons-LICENSE.txt).
