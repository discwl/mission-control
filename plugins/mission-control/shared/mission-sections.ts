export const missionSections = ["needs-you", "tasks", "review", "agents"] as const;
export type MissionSection = typeof missionSections[number];
export const missionSectionLabels: Record<MissionSection, string> = {
  "needs-you": "Needs you", tasks: "Tasks", review: "Review", agents: "Agents",
};

export function normalizeMissionSections(saved: readonly string[]): MissionSection[] {
  const known = saved.filter((section): section is MissionSection => missionSections.some(candidate => candidate === section));
  return [...new Set([...known, ...missionSections])];
}

export function moveMissionSection(saved: readonly string[], section: MissionSection, direction: -1 | 1): MissionSection[] {
  const order = normalizeMissionSections(saved);
  const index = order.indexOf(section);
  const target = index + direction;
  if (target < 0 || target >= order.length) return order;
  [order[index], order[target]] = [order[target], order[index]];
  return order;
}
