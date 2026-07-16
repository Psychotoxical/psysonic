import { libraryEntityKey } from '@/lib/library/libraryEntityKey';

/**
 * Keeps the first occurrence of each `id`. Subsonic responses (and merged pages)
 * occasionally repeat the same album/song id; duplicate React keys then warn and
 * break reconciliation.
 */
export function dedupeById<T extends { id: string; serverId?: string | null }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = libraryEntityKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
