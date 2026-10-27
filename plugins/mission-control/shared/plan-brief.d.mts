import type { PlanBrief } from "./plan-approval";
export const planBriefFields: readonly { key: keyof PlanBrief; label: string; list?: boolean; allowEmpty?: boolean }[];
export function normalizePlanBrief(value: unknown, validateText?: (text: string, label: string, max: number) => string): PlanBrief | null;
