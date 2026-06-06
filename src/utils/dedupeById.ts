/**
 * Keeps the first occurrence of each `id`. Subsonic responses (and merged pages)
 * occasionally repeat the same album/song id; duplicate React keys then warn and
 * break reconciliation.
 */
export function dedupeById<T extends { id: string; serverId?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = item.serverId ? `${item.serverId}:${item.id}` : item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
