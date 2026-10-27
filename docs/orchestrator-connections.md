# Orchestrator connections

Use the coordinator machine's saved Paseo destinations for orchestration. A temporary pairing URL file is not required after the destination has been registered.

Discover destinations with native Paseo `list_hosts`. Match the exact destination `serverId` in the orchestrator folder's `host.json`, and keep it with each worker's `agentId`, `workspaceId` and applicable task ID. Use that `serverId` with native agent/workspace tools; remote workspace IDs and paths belong to the remote machine.

For Mission Control commands:

```powershell
node plugins/mission-control/scripts/remote.mjs --server <serverId> identity
node plugins/mission-control/scripts/remote.mjs --server <serverId> summary
node plugins/mission-control/scripts/remote.mjs --server <serverId> status --workspace <workspaceId> --task <taskId>
```

`--server` connects to the local daemon, selects its existing enabled and online destination, and uses Paseo's host channel transport. It verifies the destination's Mission Control identity before sending task commands. It does not create registrations, export credentials, or fall back to local tasks. The internal DaemonClient plugin RPC dependency is unchanged; the channel transport is supplied by the installed Paseo client package.

`--local` remains an explicit choice for local Mission Control. `--offer-file` remains available for intentional legacy administrative connections. Select exactly one connection mode. Never regenerate offer files automatically when native routing fails.

Task start/resume continues through Mission Control. Preserve the originating chat's `PASEO_AGENT_ID` or supply its exact `--orchestrator-agent` ID. Existing native parent validation, saved worker linking, launch receipts and approval requirements still apply. If a launch response is lost, reconcile existing task/worker status before retrying.

Use native `send_agent_prompt` for an authorized follow-up with the exact worker address, `notifyOnFinish: true` and an appropriate active-turn behavior (normally `steer`). Return control and wait for completion. Do not send a prompt just to obtain notifications; a finished turn does not establish task completion, validation or approval.

If native tools are deferred, discover them before treating them as unavailable. Missing, disabled or offline destinations require a connection status report and recovery on the relevant machine. They do not authorize pairing regeneration, registration changes, daemon restarts, or a fallback to local tasks. Keep one-way coordinator-to-worker connections; a reverse coordinator registration is not required.

Shared provider instructions and the beginning of each host's notes should describe this current path and supersede historical connection recipes. Existing long-running chats may retain earlier instructions in memory, so they should reread the shared flow and current connection section when resumed. Do not send workers new business instructions solely to refresh connection guidance.

Validation covers exact destination selection and identity, missing/disabled/offline destinations, connection and cleanup failures, conflicting CLI selectors, and the existing native-parent launch behavior. Read-only live checks should use `identity`, `summary` or agent status without launching workers or changing registrations.
