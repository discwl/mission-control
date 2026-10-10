import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** A plain local branch name. Git's own check-ref-format runs on the host as well. */
export const branchNameSchema = z.string().trim().min(1).max(200).refine(
  name => /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith("-") && !name.startsWith("/") && !name.endsWith("/")
    && !name.endsWith(".") && !name.endsWith(".lock") && !name.includes("..") && !name.includes("//") && name !== "HEAD",
  "Use a branch name such as main or release/2026.",
);

export const projectGitEntrySchema = z.object({
  // Unset means origin's HEAD branch.
  defaultBranch: branchNameSchema.optional(),
  autoFetch: z.boolean().default(false),
});
export type ProjectGitEntry = z.infer<typeof projectGitEntrySchema>;

// Per-project Git choices, keyed by Paseo project ID.
export const projectGitSettings = defineSettings({
  id: "project-git",
  scope: "host",
  version: 1,
  schema: z.object({ projects: z.record(z.string().min(1), projectGitEntrySchema).default({}) }),
});

export const projectGitStatusSchema = z.object({
  hasOrigin: z.boolean(),
  // The branch task worktrees start from and Pull latest updates, and where that choice came from.
  defaultBranch: z.string().nullable(),
  defaultSource: z.enum(["setting", "origin"]).nullable(),
  // The main checkout's current branch; null when detached or before the first commit.
  branch: z.string().nullable(),
  // Compared with the last fetched origin/<default branch>; null when that ref is missing.
  ahead: z.number().int().nonnegative().nullable(),
  behind: z.number().int().nonnegative().nullable(),
  fetchedAt: z.string().nullable(),
  fetchError: z.string().nullable(),
});
export type ProjectGitStatus = z.infer<typeof projectGitStatusSchema>;

export const getProjectGitStatus = defineRpc({
  name: "project-git.status",
  input: z.object({ projectId: z.string().min(1), fetch: z.boolean() }),
  output: projectGitStatusSchema,
});

export const pullProjectLatest = defineRpc({
  name: "project-git.pull",
  input: z.object({ projectId: z.string().min(1) }),
  output: z.object({
    // updated: fast-forwarded; current: nothing to pull; unchanged: nothing changed, see message; failed: the fetch failed, or Git stopped partway (see message).
    outcome: z.enum(["updated", "current", "unchanged", "failed"]),
    message: z.string(),
    status: projectGitStatusSchema,
  }),
});
