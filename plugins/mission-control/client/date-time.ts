const shortDateTime = new Intl.DateTimeFormat("en-US", {
  month: "2-digit",
  day: "2-digit",
  year: "2-digit",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : shortDateTime.format(date);
}
