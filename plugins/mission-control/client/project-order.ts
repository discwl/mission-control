/** Project blocks have variable heights. Match the dragged heading to the nearest heading. */
export function projectDropTarget(visible: readonly string[], tops: ReadonlyMap<string, number>, source: string, shift: number): string {
  const origin = tops.get(source);
  if (origin === undefined) return source;
  const position = origin + shift;
  let target = source;
  let distance = Math.abs(shift);
  for (const id of visible) {
    const top = tops.get(id);
    if (top !== undefined && Math.abs(top - position) < distance) {
      target = id;
      distance = Math.abs(top - position);
    }
  }
  return target;
}
