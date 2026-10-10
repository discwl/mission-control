import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import manifestJson from "./setup-manifest.json";

// Settings → Setup (task 20): each dependency's status on the plugin's host, and the three installs Mission Control may
// run after a confirmation: skill links, the pinned OCR CLI and OCR rule files. Everything else only shows its version
// and the command or link. Output shown here passes through hideSecrets first.

export const setupStatuses = ["installed", "outdated", "missing", "modified", "not-managed", "unknown"] as const;
export type SetupStatus = typeof setupStatuses[number];
export const setupStatusLabels: Record<SetupStatus, string> = {
  installed: "Installed", outdated: "Outdated", missing: "Missing", modified: "Modified", "not-managed": "Not managed", unknown: "Unknown",
};

// ---------- manifest ----------

const detectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paseo") }),
  z.object({
    kind: z.literal("command"), command: z.string().regex(/^[a-z][a-z0-9-]*$/), args: z.array(z.string()),
    /** Folders searched after PATH, relative to an environment variable such as LOCALAPPDATA. */
    extraDirs: z.array(z.object({ env: z.string(), path: z.string() })).optional(),
  }),
  z.object({ kind: z.literal("npm-self") }),
  z.object({
    kind: z.literal("npm-package"), package: z.string(), provider: z.string().optional(),
    /** Where the tool keeps versions it downloads for itself, one folder per version; the newest one counts. */
    selfUpdateDir: z.object({ env: z.string(), path: z.string() }).optional(),
  }),
  z.object({ kind: z.literal("ocr-rules") }),
  z.object({ kind: z.literal("obsidian-app") }),
  z.object({ kind: z.literal("obsidian-cli") }),
  // The pull request tools (task 21): gh and its sign-in, az with the azure-devops extension and its sign-in, and
  // whether Bitbucket Cloud credentials exist. Show-only; nothing is installed or signed in from here.
  z.object({ kind: z.literal("gh") }),
  z.object({ kind: z.literal("az") }),
  z.object({ kind: z.literal("bitbucket-credentials") }),
]);
export type SetupDetect = z.infer<typeof detectSchema>;

const helpSchema = z.object({ text: z.string(), command: z.string().nullable(), link: z.string().nullable() });

export const setupManifestSchema = z.object({
  schemaVersion: z.literal(1),
  note: z.string().optional(),
  dependencies: z.array(z.object({
    id: z.string(), name: z.string(), section: z.enum(["paseo", "tools", "providers"]),
    detect: detectSchema, minimum: z.string().nullable(), pinned: z.string().nullable(),
    install: z.enum(["mission-control", "manual"]), optional: z.boolean(), help: helpSchema,
  })),
  ocr: z.object({
    package: z.string(), version: z.string(), home: z.string(),
    files: z.array(z.object({ path: z.string(), source: z.string() })),
  }),
  skills: z.object({
    kitFolder: z.string(),
    delegate: z.object({ name: z.string(), source: z.string(), version: z.string() }),
    providers: z.array(z.object({ id: z.string(), name: z.string(), folder: z.string() })),
  }),
});
export type SetupManifest = z.infer<typeof setupManifestSchema>;
export type SetupDependency = SetupManifest["dependencies"][number];

export const setupManifest: SetupManifest = setupManifestSchema.parse(manifestJson);

// ---------- status report ----------

export const setupItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(setupStatuses),
  version: z.string().nullable(),
  /** The pinned or minimum version, for example "pinned 1.12.9" or "≥ 22.0.0". */
  expected: z.string().nullable(),
  /** What was found and where; errors are shown here too. */
  detail: z.string(),
  help: helpSchema,
  optional: z.boolean(),
  /** Mission Control may install or update it after a confirmation. */
  installable: z.boolean(),
  /** For gh and az: whether the tool is signed in (and, for az, has the azure-devops extension). */
  signIn: z.object({ signedIn: z.boolean(), detail: z.string() }).nullable().optional(),
});
export type SetupItem = z.infer<typeof setupItemSchema>;

export const skillLinkSchema = z.object({
  name: z.string(),
  path: z.string(),
  /** The folder the link should point at. */
  target: z.string(),
  status: z.enum(setupStatuses),
  note: z.string().nullable(),
});
export type SkillLink = z.infer<typeof skillLinkSchema>;

export const skillGroupIds = ["development-flow", "ocr-delegate"] as const;
export type SkillGroupId = typeof skillGroupIds[number];

export const skillGroupSchema = z.object({
  provider: z.string(),
  providerName: z.string(),
  group: z.enum(skillGroupIds),
  folder: z.string(),
  folderExists: z.boolean(),
  status: z.enum(setupStatuses),
  links: z.array(skillLinkSchema),
  /** Why installing isn't possible, or null. */
  blocked: z.string().nullable(),
});
export type SkillGroup = z.infer<typeof skillGroupSchema>;

export const ocrRuleFileSchema = z.object({ path: z.string(), source: z.string(), status: z.enum(setupStatuses), note: z.string().nullable() });

export const kitProfileSchema = z.object({
  file: z.string(),
  projectId: z.string().nullable(),
  kitRoot: z.string().nullable(),
  status: z.enum(setupStatuses),
  /** "Developer checkout", "Folder", or why it couldn't be used. */
  detail: z.string(),
  developerCheckout: z.boolean(),
});

export const setupLogEntrySchema = z.object({
  at: z.string(),
  action: z.string(),
  summary: z.string(),
  ok: z.boolean(),
  /** Paths written or the command run. */
  changes: z.array(z.string()),
  /** The end of the command's output, with key-like strings hidden. */
  output: z.string().nullable(),
});
export type SetupLogEntry = z.infer<typeof setupLogEntrySchema>;


// ---------- installs ----------

export const setupActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skills"), provider: z.string().max(40), group: z.enum(skillGroupIds) }),
  z.object({ kind: z.literal("ocr-cli") }),
  z.object({ kind: z.literal("ocr-rules") }),
  // Points project profiles at the stable kit path instead of one install's folder.
  z.object({ kind: z.literal("kit-root") }),
]);
export type SetupAction = z.infer<typeof setupActionSchema>;

export const setupChangeSchema = z.object({
  path: z.string(),
  change: z.enum(["create-link", "replace-link", "write-file", "update-file", "run-command", "skip"]),
  detail: z.string(),
});
export type SetupChange = z.infer<typeof setupChangeSchema>;

/** What an install would do, shown for confirmation. Apply refuses unless the state still has this fingerprint. */
export const setupPlanSchema = z.object({
  action: setupActionSchema,
  title: z.string(),
  /** The command as the user would type it, or null for file changes. */
  command: z.string().nullable(),
  changes: z.array(setupChangeSchema),
  /** Why nothing can be done, or null. */
  blocked: z.string().nullable(),
  fingerprint: z.string(),
});
export type SetupPlan = z.infer<typeof setupPlanSchema>;

export const setupResultSchema = z.object({
  action: setupActionSchema,
  /**
   * The install was still going when apply replied, so `ok` and the rest aren't known yet. The screen follows it through
   * the report's `running` and `lastResult`, the way Start task follows a slow launch.
   */
  running: z.boolean(),
  /** When apply started it; the screen matches a running install's result by it. */
  startedAt: z.string(),
  ok: z.boolean(),
  summary: z.string(),
  changes: z.array(z.string()),
  output: z.string().nullable(),
});
export type SetupResult = z.infer<typeof setupResultSchema>;

/** An install still running on this host, started from any screen. */
export const setupRunningSchema = z.object({ action: setupActionSchema, title: z.string(), startedAt: z.string() });
/** The last install this plugin server finished, kept until it restarts; the log keeps older ones. */
export const setupFinishedSchema = setupResultSchema.extend({ title: z.string(), finishedAt: z.string() });
export type SetupFinished = z.infer<typeof setupFinishedSchema>;

export const planSetupAction = defineRpc({ name: "setup.plan", input: setupActionSchema, output: setupPlanSchema });
export const applySetupAction = defineRpc({
  name: "setup.apply",
  input: z.object({ action: setupActionSchema, fingerprint: z.string().max(128) }),
  output: setupResultSchema,
});

// ---------- the report ----------

export const setupReportSchema = z.object({
  checkedAt: z.string(),
  home: z.string(),
  paseo: setupItemSchema,
  vault: z.object({
    root: z.string(),
    exists: z.boolean(),
    hostJson: z.object({ status: z.enum(setupStatuses), detail: z.string() }),
  }),
  kit: z.object({
    profiles: z.array(kitProfileSchema),
    /** The kit the skill links point at: the one kitRoot every profile agrees on. */
    root: z.string().nullable(),
    rootNote: z.string().nullable(),
    /**
     * A link Mission Control keeps pointed at its current Paseo-managed install, which every update replaces, so
     * kitRoot, skill links and agents' paths survive updates. `profilesToMove` still name one install's folder.
     */
    stable: z.object({
      path: z.string(),
      target: z.string().nullable(),
      status: z.enum(setupStatuses),
      detail: z.string(),
      profilesToMove: z.array(z.string()),
    }).optional(),
  }),
  skills: z.array(skillGroupSchema),
  tools: z.array(setupItemSchema),
  ocrRules: z.object({ folder: z.string(), files: z.array(ocrRuleFileSchema) }),
  providers: z.array(setupItemSchema),
  log: z.array(setupLogEntrySchema),
  running: setupRunningSchema.nullable(),
  lastResult: setupFinishedSchema.nullable(),
  // Forge tools left out because no project on this host uses their forge (Settings → Delivery shows each project's forge).
  hiddenTools: z.array(z.object({ id: z.string(), name: z.string(), reason: z.string() })).default([]),
});
export type SetupReport = z.infer<typeof setupReportSchema>;

export const readSetup = defineRpc({ name: "setup.read", input: z.object({}), output: setupReportSchema });
