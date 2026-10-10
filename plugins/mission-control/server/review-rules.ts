import type { Severity } from "../shared/review";

// Categories follow Review Deck's FindingDetector (MIT, github.com/mentalfl0w/review-deck),
// with word boundaries so `hash` no longer matches `HashMap`, and path awareness added.

const rank: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3 };
export const severityRank = (severity: Severity) => rank[severity];
export const maxSeverity = (values: Severity[]): Severity =>
  values.reduce<Severity>((best, value) => (rank[value] > rank[best] ? value : best), "info");

type ContentRule = { reason: string; severity: Severity; pattern: RegExp; removed?: boolean; removedOnly?: boolean };

const exportPattern = /^\s*(export\s+(default\s+)?(async\s+)?(function|class|const|let|interface|type|enum)\b|pub\s+(fn|struct|enum|trait)\b|public\s+[\w<>[\]]+\s+\w+\s*\()/;
const contentRules: ContentRule[] = [
  // Changing or removing an export can break callers; adding one cannot.
  { reason: "Public API change", severity: "high", removedOnly: true, pattern: exportPattern },
  { reason: "New export", severity: "medium", pattern: exportPattern },
  { reason: "Database schema", severity: "high", removed: true, pattern: /\b(ALTER|DROP|CREATE)\s+TABLE\b|\bmigrations?\b/i },
  { reason: "Security-sensitive", severity: "high",
    pattern: /\b(eval|child_process|execSync|execFile|spawn|innerHTML|dangerouslySetInnerHTML|password|secret|api[_-]?key|private[_-]?key|chmod|setuid)\b|rm\s+-rf/i },
  { reason: "Concurrency", severity: "high", pattern: /\b(mutex|semaphore|lock_guard|rwlock|synchronized|atomic|Atomics)\b|\bwithRunLock\b|\.lock\(/ },
  { reason: "Error handling", severity: "medium", removed: true, pattern: /\b(catch|throw|finally|panic!|unwrap)\b/ },
  { reason: "File writes", severity: "medium", pattern: /\b(writeFile|appendFile|rename|unlink|rmdir|mkdir|rm)(Sync)?\s*\(/ },
];

type PathRule = { reason: string; test: RegExp; cap?: Severity; floor?: Severity };

const pathRules: PathRule[] = [
  { reason: "Test", test: /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$/i, cap: "low" },
  { reason: "Docs", test: /\.(md|mdx|txt|rst|adoc)$/i, cap: "info" },
  { reason: "Lockfile", test: /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock)$/, cap: "info" },
  { reason: "Generated", test: /(^|\/)(dist|build|out|coverage)\/|\.min\.(js|css)$|\.map$/, cap: "info" },
  { reason: "CI / build", test: /(^|\/)(\.github\/workflows\/|Dockerfile$|docker-compose|Makefile$)|\.(ya?ml)$/i, floor: "medium" },
  { reason: "Sensitive path", test: /(^|\/)(auth|security|crypto|permissions?|secrets?)(\/|\.|_)|(^|\/)\.env/i, floor: "medium" },
];

const commentOnly = /^\s*(\/\/|#|\*|\/\*|\*\/|<!--|--)/;

/** Severity of one change block from its path and changed lines. */
export function classifyHunk(path: string, lines: string[]): { severity: Severity; reasons: string[] } {
  const added = lines.filter(line => line.startsWith("+")).map(line => line.slice(1));
  const removed = lines.filter(line => line.startsWith("-")).map(line => line.slice(1));
  const reasons: string[] = [];
  let severity: Severity = "info";
  for (const rule of contentRules) {
    const inRemoved = removed.some(line => rule.pattern.test(line));
    const hit = rule.removedOnly ? inRemoved : added.some(line => rule.pattern.test(line)) || (rule.removed === true && inRemoved);
    if (rule.reason === "New export" && reasons.includes("Public API change")) continue;
    if (hit) { reasons.push(rule.reason); severity = maxSeverity([severity, rule.severity]); }
  }
  const meaningful = [...added, ...removed].filter(line => line.trim() && !commentOnly.test(line));
  if (reasons.length === 0) {
    if (meaningful.length) { reasons.push("Logic change"); severity = "low"; }
    else reasons.push("Comments or formatting");
  }
  for (const rule of pathRules) {
    if (!rule.test.test(path)) continue;
    reasons.unshift(rule.reason);
    if (rule.cap && rank[severity] > rank[rule.cap]) severity = rule.cap;
    if (rule.floor && meaningful.length && rank[severity] < rank[rule.floor]) severity = rule.floor;
  }
  return { severity, reasons: [...new Set(reasons)] };
}
