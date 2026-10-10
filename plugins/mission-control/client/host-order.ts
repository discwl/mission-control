// Keep saved hosts that are absent from this client; append newly paired hosts.
export function mergeHostOrder(saved: readonly string[], available: readonly string[]): string[] {
  return [...new Set([...saved, ...available])];
}

// Reorder only the visible slots so search/offline filters cannot erase or move hidden hosts.
export function moveVisibleHost(order: readonly string[], visible: readonly string[], source: string, target: string): string[] {
  const visibleSet = new Set(visible);
  const items = order.filter(id => visibleSet.has(id));
  const from = items.indexOf(source);
  const to = items.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...order];
  items.splice(to, 0, items.splice(from, 1)[0]);
  let index = 0;
  return order.map(id => visibleSet.has(id) ? items[index++] : id);
}
