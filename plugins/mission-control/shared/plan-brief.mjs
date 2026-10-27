// Shared by the CLI, snapshot reader and human-facing approval view.
export const planBriefFields = [
  { key: "goal", label: "Goal" },
  { key: "before", label: "Before the change" },
  { key: "after", label: "After the change / example" },
  { key: "included", label: "Included", list: true },
  { key: "deferred", label: "Deferred / untouched", list: true },
  { key: "scopeChange", label: "Scope changes from the original request" },
  { key: "affected", label: "People, accounts or systems affected", list: true },
  { key: "approach", label: "Proposed steps", list: true },
  { key: "successChecks", label: "How we will show it works", list: true },
  { key: "risks", label: "Tradeoffs and risks", list: true },
  { key: "authorization", label: "What approval allows next" },
  { key: "changesSincePrevious", label: "Author's change summary", list: true, allowEmpty: true },
];

export function normalizePlanBrief(value, validateText = text => text) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("planBrief must be an object.");
  const result = {};
  const text = (value, label) => {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 600) throw new Error(`${label} needs 1–600 characters in everyday language.`);
    return validateText(value.trim(), label, 600);
  };
  for (const field of planBriefFields) {
    const label = `planBrief.${field.key}`;
    if (field.list) {
      const items = value[field.key];
      if (!Array.isArray(items) || items.length > 8 || (!field.allowEmpty && !items.length)) throw new Error(`${label} needs ${field.allowEmpty ? "0" : "1"}–8 short items; say explicitly when none apply.`);
      result[field.key] = items.map((item, index) => text(item, `${label}[${index}]`));
    } else result[field.key] = text(value[field.key], label);
  }
  return result;
}
