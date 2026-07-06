import { useMemo } from 'react';
import type { LocalPlaybackEntry } from '@/store/localPlaybackStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { entryBelongsToServer } from '@/store/localPlaybackResolve';

function isBrowsableLocalEntry(entry: LocalPlaybackEntry, serverId: string): boolean {
  return (entry.tier === 'library' || entry.tier === 'favorite-auto' || entry.tier === 'ephemeral')
    && !!entry.localPath
    && entryBelongsToServer(entry, serverId);
}

export function listBrowsableLocalEntries(
  serverId: string,
  entries: Record<string, LocalPlaybackEntry>,
): LocalPlaybackEntry[] {
  return Object.values(entries).filter(e => isBrowsableLocalEntry(e, serverId));
}

/** Stable revision for on-disk browse bytes — bumps when pins or hot-cache rows change. */
export function offlineLocalBrowseRevision(
  serverId: string,
  entries: Record<string, LocalPlaybackEntry>,
): string {
  return listBrowsableLocalEntries(serverId, entries)
    .map(e => `${e.trackId}:${e.tier}:${e.cachedAt}`)
    .sort()
    .join('\0');
}

export function countBrowsableLocalEntries(
  serverId: string,
  entries: Record<string, LocalPlaybackEntry>,
): number {
  return listBrowsableLocalEntries(serverId, entries).length;
}

/** Reactive local-bytes revision for offline browse reload keys. */
export function useOfflineLocalBrowseRevision(
  serverId: string | null | undefined,
): string {
  const entries = useLocalPlaybackStore(s => s.entries);
  return useMemo(
    () => (serverId ? offlineLocalBrowseRevision(serverId, entries) : ''),
    [serverId, entries],
  );
}
