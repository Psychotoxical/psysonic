import { useMemo } from 'react';
import type { LocalPlaybackEntry } from '@/store/localPlaybackStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { hasBrowsableLocalPlaybackBytes } from '@/lib/localPlayback/browsablePlaybackTiers';
import { entryBelongsToServer } from '@/store/localPlaybackResolve';
import { useOfflineLocalLibrarySyncRevision } from '@/store/offlineLocalLibrarySyncRevision';

function listBrowsableLocalEntries(
  serverId: string,
  entries: Record<string, LocalPlaybackEntry>,
): LocalPlaybackEntry[] {
  return Object.values(entries).filter(
    e => hasBrowsableLocalPlaybackBytes(e) && entryBelongsToServer(e, serverId),
  );
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

/** Entries + library sync revisions for offline browse catalog reload keys. */
export function useOfflineLocalBrowseReloadKey(
  serverId: string | null | undefined,
  offlineBrowseActive: boolean,
): string {
  const entriesRev = useOfflineLocalBrowseRevision(offlineBrowseActive ? serverId : null);
  const syncRev = useOfflineLocalLibrarySyncRevision(offlineBrowseActive ? serverId : null);
  return useMemo(
    () => (offlineBrowseActive ? `${entriesRev}\0${syncRev}` : ''),
    [offlineBrowseActive, entriesRev, syncRev],
  );
}

export function countLocalBrowsableTracksFromEntries(
  serverId: string,
  entries: Record<string, LocalPlaybackEntry>,
): number {
  return countBrowsableLocalEntries(serverId, entries);
}
