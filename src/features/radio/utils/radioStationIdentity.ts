import type { InternetRadioStation } from '@/lib/api/subsonicTypes';
import { libraryEntityKey } from '@/lib/library/libraryEntityKey';

/** Upgrades pre-multi-server ids without changing already-qualified identities. */
export function qualifyStoredRadioIds(
  storedIds: string[],
  stations: InternetRadioStation[],
  activeServerId?: string | null,
): string[] {
  const currentKeys = new Set(stations.map(libraryEntityKey));
  const byRawId = new Map<string, InternetRadioStation[]>();
  for (const station of stations) {
    const matches = byRawId.get(station.id) ?? [];
    matches.push(station);
    byRawId.set(station.id, matches);
  }

  const resolved: string[] = [];
  for (const storedId of storedIds) {
    let key = currentKeys.has(storedId) ? storedId : undefined;
    if (!key) {
      const matches = byRawId.get(storedId) ?? [];
      const preferred = matches.find(station => station.serverId === activeServerId)
        ?? (matches.length === 1 ? matches[0] : undefined);
      if (preferred) key = libraryEntityKey(preferred);
    }
    const preservedKey = key ?? storedId;
    if (!resolved.includes(preservedKey)) resolved.push(preservedKey);
  }
  return resolved;
}
