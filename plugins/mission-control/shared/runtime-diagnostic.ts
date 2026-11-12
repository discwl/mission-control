import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const runtimeDiagnosticInput = z.object({
  serverId: z.string().min(1).max(200),
  acknowledgeSyntheticWrites: z.literal(true),
}).strict();
export const runtimeDiagnosticOutput = z.object({
  probeVersion: z.literal("mc-runtime-v1"),
  serverId: z.string(), startedAt: z.string(), durationMs: z.number(),
  status: z.enum(["passed", "failed"]),
  runtime: z.object({ execPath: z.string(), node: z.string(), electron: z.string().nullable(), modules: z.string().nullable(), pid: z.number(), ppid: z.number() }),
  volume: z.object({ id: z.string(), serial: z.string(), filesystem: z.literal("NTFS"), root: z.string() }).nullable(),
  directory: z.string().nullable(),
  checks: z.array(z.string().max(200)).max(12),
  error: z.string().max(500).nullable(),
  cleanup: z.enum(["not-created", "removed", "retained"]),
  limitations: z.array(z.string().max(300)).max(8),
});
export const runRuntimeDiagnostic = defineRpc({
  name: "diagnostics.run-lock-runtime", input: runtimeDiagnosticInput, output: runtimeDiagnosticOutput,
});
export type RuntimeDiagnosticResult = z.infer<typeof runtimeDiagnosticOutput>;
