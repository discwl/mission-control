# Recover an invalid task status

This administrative recovery changes a task record whose only invalid field is a nonempty status string. It does not close a tracker ticket, approve work, resolve a decision, launch an agent, or infer that work is complete. Verify the user's intended status and its authorization evidence before applying it. The normal task parser remains strict.

The public operations below become available only after this change is reviewed and installed on the owning host. Local tests do not repair a remote record. Use an identity-checked client routed to that host; do not invoke the operations on Personal for a remote task.

```ts
const ref = { serverId, workspaceId, projectId, taskId };
const inspection = await routedClient.invokePluginRpc(
  "mission-control", "tasks.status-recovery.inspect", ref,
);
// Review inspection.revision, recordedStatus, recoverable and exact identity.
// Fill these from actual user authorization; never infer a target from "done".
const result = await routedClient.invokePluginRpc(
  "mission-control", "tasks.status-recovery.apply", {
    ...ref,
    expectedRevision: inspection.revision,
    targetStatus: "closed",
    actor: "The actual submitting operator or coordinator",
    reason: "The concrete status-record correction being requested",
    authorizationEvidence: "Reference and exact scope of the user's authorization",
  },
);
```

`targetStatus` must be one of `inbox`, `ready`, `in_progress`, `blocked`, `in_review`, `delivered`, or `closed`. All apply fields are required. `expectedRevision` is the SHA-256 of the exact task-file bytes, not its timestamp or vault entry revision. The actor and authorization evidence are caller declarations recorded for audit, not authenticated identity overrides or new approval authority. There is no automatic `done` → `closed` mapping.

Inspect verifies the host's vault identity, live workspace/project, task path, task's host/project and workspace assignment. It rejects missing or duplicate frontmatter, other schema errors, unknown keys including nested keys, linked paths, hardlinks, and a legacy record alongside the task folder. A valid status returns `recoverable: false`; apply then refuses it. Only folder-based task records are supported.

Apply takes the same task lock as the normal writers and repeats identity and hash checks. It changes the status and advances `updatedAt` to invalidate older normal status-editor snapshots. All other metadata and body bytes remain unchanged. It writes and flushes an original `before.md` backup plus `prepared.json` audit before the atomic task-file replacement, then reads back the exact resulting hash. On success it also writes `applied.json`. Evidence is retained under the returned `auditPath`, a protected `.mission-control-recovery-<uuid>` folder inside that task. The existing public `read-vault-file` operation can read those exact evidence paths; ordinary vault editing cannot change them.

An existing lock is never deleted, taken over, or declared stale from its age. If the task changed or the identity is ambiguous, stop and inspect rather than retrying with a guessed revision. Concurrent supported writers are excluded by the shared lock; unsupported direct file writers must be stopped before recovery. This operation cannot make arbitrary external filesystem writes obey that lock.

After a timeout or crash, read the task through `tasks.status-recovery.inspect` or existing `read-vault-file`, and compare it with the saved audit hashes. `prepared.json` alone is an intention, not proof that replacement happened. There is no automatic rollback, replay, or lock cleanup. A cleanup or final-receipt warning alongside `applied: true` means the corrected task was read back successfully; do not repeat the mutation. Retain the evidence and investigate the warning separately. A lost response without successful readback leaves the result unconfirmed.

For a record rejected by the normal task parser, the pre-existing public read is:

```ts
await routedClient.invokePluginRpc("mission-control", "read-vault-file", {
  path: `Tasks/${taskId}/task.md`,
});
```

That read returns raw content and its hash; it grants no editing authority. Ordinary `tasks.status.update`, task Docs save, and vault save are not malformed-record recovery routes.
