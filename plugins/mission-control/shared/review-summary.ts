import type { DecisionEntry } from "./decisions";

/** Saved owner brief; never infer checks or caveats from a technical report. */
export function reviewSummary(entry: DecisionEntry): string {
  const plain = entry.decision.plain;
  const lines = (items: string[] | undefined, missing: string) => items?.length ? items.map(item => `• ${item}`).join("\n") : missing;
  return [
    "What changed", plain?.built ?? "A readable change summary was not supplied. Open the full review before accepting.",
    "", "Review outcome", plain?.found || "A readable review outcome was not supplied.",
    "", "Reported checks", lines(plain?.checks, "Checks were not listed in this saved brief. Open the full review for the test evidence."),
    "", "Limitations and remaining work", lines(plain?.limitations, "Limitations were not listed in this saved brief. Do not assume live or production behavior was verified."),
  ].join("\n");
}
