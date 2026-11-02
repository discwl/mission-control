# Restore a missing Mission Control task record

This recovery restores an authoritative original `task.md` into its existing task folder. It preserves the original bytes, status, timestamps, assignments, runs and decisions. It does not create a task, resolve a decision, approve code, send a prompt or change application source. Use the normal decision workflow afterward, with fresh candidate and decision-revision evidence.

The two public plugin RPCs are `tasks.missing-record.inspect` and `tasks.missing-record.apply`. They run against the target host's configured vault; callers cannot supply a filesystem path or vault root. Use an identity-verified routed client to that exact host. A successful local fixture test is not proof of a remote repair.

## Preconditions and limits

An operator must first establish that the backup is an original record, obtain explicit restoration authorization, and retain the provenance evidence. A hash proves byte integrity, not historical authority or user approval. The API records actor and authorization evidence as **caller-declared**; it does not authenticate a human identity from prose.

The task folder, host record, unique project profile, selected run and all surviving run/decision records must exist and agree with the supplied identity. Both the canonical task record and any legacy task record must be absent. Every original workspace assignment must belong to the selected host and refresh successfully with the expected native project. Missing, archiving, unavailable or mismatched workspace evidence fails closed. Unknown task fields, schema defaults that would change the original metadata, duplicate fields/assignments, links, ambiguous profiles and foreign identities are rejected. Backups and provenance each have a 200 KB UTF-8 limit. Provenance must be a JSON object.

A decision with pending or uncertain resume delivery blocks restoration: making the task visible must not implicitly unblock a queued worker prompt. No delivery guard is waived. This endpoint is deliberately narrower than general vault repair; incomplete historical evidence may require a separate recovery design.

Apply holds the existing task and run lock filenames, verifies ownership, and rechecks the inspection fingerprint before publication. It never steals a lock. A competing writer or changed run, decision, profile, native identity or directory identity invalidates inspection. These guards coordinate cooperative Mission Control writers; they are not a security boundary against a malicious administrator replacing directories between filesystem calls.

## Public contract

```ts
const input = {
  serverId, workspaceId, projectId, taskId, runId,
  backupContent,                 // exact UTF-8 original task.md
  expectedBackupRevision,        // lowercase SHA-256 of those bytes
  provenanceContent,             // exact UTF-8 JSON evidence manifest
  expectedProvenanceRevision,    // lowercase SHA-256 of those bytes
};
const inspection = await client.invokePluginRpc(
  'mission-control', 'tasks.missing-record.inspect', input,
);
// inspection: { task, inspectionRevision, backupRevision,
//               provenanceRevision, targetAbsent: true, runIds }

// Only after explicit authorization for this exact restore:
const result = await client.invokePluginRpc(
  'mission-control', 'tasks.missing-record.apply', {
    ...input,
    expectedInspectionRevision: inspection.inspectionRevision,
    confirmation: 'restore-original-record',
    actor: 'Operator identity and represented user, if applicable',
    reason: 'Why this verified original record must be restored',
    authorizationEvidence: 'Actual scoped authorization quote and receipt',
  },
);
// result: { applied: true, task, revision, inspectionRevision,
//           auditPath, warnings: string[] }
```

Both inputs reject unknown properties. `taskId` and `runId` must have the normal prefixed hexadecimal/hyphen format. Actor, reason and authorization evidence are required nonempty strings (maximum 300, 2,000 and 4,000 characters respectively). Apply consumes the fingerprint from a fresh inspection; it does not accept an arbitrary stale snapshot.

## Atomic publication, audit and uncertain results

Before publication the task folder receives a uniquely named `.mission-control-restore-<uuid>` audit directory containing `original-task.md`, `provenance.json`, `prepared.json` and a staged candidate. The original bytes and prepared audit are synced before publication. `prepared.json` records the selectors, hashes, inspection, caller-declared actor and authorization, with `applied: false`.

Publication uses a same-filesystem hard link with exclusive destination semantics. An existing destination is never replaced. Filesystems that cannot support this operation fail closed; there is no rename/overwrite fallback. The staged link is removed and the destination bytes are checked. `applied.json` records completion when possible. Directory entries are not independently fsynced, so this is not a guarantee against every power-loss/filesystem failure.

If completion-audit or lock cleanup fails after verified publication, the response remains `applied: true` with warnings. Do not interpret cleanup failure as a failed restore or repeat the mutation. If an exception occurs after a publication attempt, the error explicitly requires readback before any retry. A timeout is also an unknown outcome. Inspect the exact public task document, compare its revision/bytes and retained audit evidence, and escalate any discrepancy. Do not delete locks, remove audit directories, overwrite a record, or retry blindly. A second successful apply is impossible once the target exists.

## Prepared WestCap CDR-1445 operation

This is a recipe, not an executed restore or publication authorization.

- Server: `srv_47MYesw0-wCf`
- Project: `prj_b44e4cec37ec6ded`
- Selected worktree workspace: `wks_18b5ff8d545abf60`
- Original source workspace: `wks_12625416a27402d0`
- Task: `task_e7ddbf8c-3513-4e68-813c-0ca4b6976aac`
- Run: `run_326c58f9-2aa0-4101-80b6-d6a08bc9bb0a`
- Original backup: `C:/Code/Orchestrator/WestCap/data/cdr1445-original-task-snapshot-20261102.md`, 1,791 bytes, SHA-256 `cc5cda282e497b2f100245647565d99d47cd1ca584ee1d20e9051786460b19bb`
- Manifest: `C:/Code/Orchestrator/WestCap/data/cdr1445-original-task-manifest-20261102.json`, 56,379 bytes, SHA-256 `136048cccc33c0cbc4700885251729b02bd37caf25aa296650b496f5477da6f4`

After separate scoped publication and restoration authorization: publish only the reviewed five-file candidate, prepare a clean artifact from that commit, update WestCap's plugin only through supported managed update, and verify the running revision and plugin health. Preserve every unrelated dirty file and other host installation. Then route to the verified WestCap host, verify the saved backup/manifest hashes, inspect, apply once with the actual authorization receipt, and read back the restored public task. If a guard refuses, report the specific evidence gap; do not substitute a reconstruction.

Global owns that remote operation. After restoration, independently reconcile the actual current decision revision and approved v4 candidate before recording the user's existing chat consent through normal decision resolution. Restoration itself records no acceptance.

The five candidate files are this document, `plugins/mission-control/shared/missing-task-recovery.ts`, `plugins/mission-control/server/missing-task-recovery.ts`, `plugins/mission-control/server/missing-task-recovery.test.mjs`, and the additive registration in `plugins/mission-control/index.server.ts`. Existing launch diagnostics, CLI changes, user-guide and UX work are excluded.
