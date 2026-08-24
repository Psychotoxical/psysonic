import { libraryUpsertSongsFromApi } from '@/lib/api/library';
import { librarySqlServerId } from '@/lib/api/coverCache';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import {
  localPlaybackPinSources,
  useLocalPlaybackStore,
  type LocalPlaybackEntry,
  type PinSource,
} from '@/store/localPlaybackStore';
import { getMediaDir } from '@/lib/media/mediaDir';
import { discoverLibraryTierOnDisk, pruneOrphanLibraryTierFiles } from '@/lib/api/syncfs';
import { resolveIndexKey, serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import {
  entryBelongsToServer,
  findLocalPlaybackEntry,
  indexKeyBelongsToServer,
} from '@/store/localPlaybackResolve';
import type { LibraryTierDiskHit } from '@/generated/bindings';
import {
  runOfflineServerMaintenance,
  waitForOfflineTrackDeletion,
} from '@/features/offline/utils/offlineOperationCoordinator';

interface LibraryTrackProbeResult {
  path: string;
  size: number;
  layoutFingerprint: string;
  exists: boolean;
}

export interface LibraryTierReconcileResult {
  syncedFromDisk: number;
  removedStaleIndex: number;
  orphansRemoved: number;
}

function serverIndexKeyForServerId(serverId: string): string {
  const server = useAuthStore.getState().servers.find(s => s.id === serverId);
  if (server) {
    return serverIndexKeyForProfile(server) || resolveIndexKey(serverId) || serverId;
  }
  return resolveIndexKey(serverId) || serverId;
}

function collectCandidateTrackIds(serverId: string, extraTrackIds: string[] = []): string[] {
  const lp = useLocalPlaybackStore.getState();
  const ids = new Set(extraTrackIds);
  for (const entry of libraryEntriesForServer(serverId)) {
    ids.add(entry.trackId);
  }
  for (const group of lp.listPinnedGroups()) {
    if (!indexKeyBelongsToServer(group.serverIndexKey, serverId)) continue;
    for (const trackId of group.trackIds) ids.add(trackId);
  }
  return [...ids];
}

function libraryEntriesForServer(serverId: string): LocalPlaybackEntry[] {
  return Object.values(useLocalPlaybackStore.getState().entries).filter(
    e => e.tier === 'library' && entryBelongsToServer(e, serverId),
  );
}

async function upsertFromProbe(
  probe: LibraryTrackProbeResult,
  serverIndexKey: string,
  serverId: string,
  trackId: string,
  suffix: string,
  pinSource?: PinSource,
  pinSources?: PinSource[],
): Promise<void> {
  await waitForOfflineTrackDeletion(serverIndexKey, trackId);
  const lp = useLocalPlaybackStore.getState();
  const existing = findLocalPlaybackEntry(trackId, serverId);
  if (existing && existing.serverIndexKey !== serverIndexKey) {
    lp.removeEntry(trackId, existing.serverIndexKey, 'reconcile-key-normalize');
  }
  lp.upsertEntry({
    serverIndexKey,
    trackId,
    localPath: probe.path,
    sizeBytes: probe.size,
    layoutFingerprint: probe.layoutFingerprint,
    tier: 'library',
    pinSource: pinSource ?? existing?.pinSource,
    pinSources: pinSources ?? (existing ? localPlaybackPinSources(existing) : undefined),
    suffix,
  });
}

async function discoverLibraryTierHits(
  serverId: string,
  candidateTrackIds: string[],
): Promise<LibraryTierDiskHit[]> {
  const serverIndexKey = serverIndexKeyForServerId(serverId);
  const libraryServerId = librarySqlServerId(serverId);
  try {
    return await discoverLibraryTierOnDisk({
      serverIndexKey,
      libraryServerId,
      candidateTrackIds,
      mediaDir: getMediaDir(),
    });
  } catch {
    return [];
  }
}

async function importLibraryTierFromDisk(
  serverId: string,
  candidateTrackIds: string[],
  shouldContinue: () => boolean = () => true,
): Promise<{
  hits: LibraryTierDiskHit[];
  imported: number;
  hitByTrackId: Map<string, LibraryTierDiskHit>;
}> {
  const serverIndexKey = serverIndexKeyForServerId(serverId);
  const hits = await discoverLibraryTierHits(serverId, candidateTrackIds);
  const hitByTrackId = new Map(hits.map(hit => [hit.trackId, hit]));
  let imported = 0;
  for (const hit of hits) {
    if (!shouldContinue()) break;
    const existing = findLocalPlaybackEntry(hit.trackId, serverId);
    if (
      existing
      && existing.localPath === hit.path
      && existing.layoutFingerprint === hit.layoutFingerprint
      && existing.sizeBytes === hit.size
      && existing.serverIndexKey === serverIndexKey
    ) {
      continue;
    }
    await upsertFromProbe(
      {
        path: hit.path,
        size: hit.size,
        layoutFingerprint: hit.layoutFingerprint,
        exists: true,
      },
      serverIndexKey,
      serverId,
      hit.trackId,
      hit.suffix || 'mp3',
      existing?.pinSource,
      existing ? localPlaybackPinSources(existing) : undefined,
    );
    imported += 1;
  }
  return { hits, imported, hitByTrackId };
}

/**
 * Bidirectional library-tier reconcile for one server scope:
 * - index row without bytes at canonical path → drop index row
 * - bytes at canonical path without index → upsert index row
 * - on-disk files not in the kept set → delete (orphan cleanup)
 */
/** Directory-first sweep for every configured server profile. */
export async function reconcileAllLibraryTiersFromDisk(): Promise<void> {
  for (const server of useAuthStore.getState().servers) {
    await reconcileLibraryTierForServer(server.id);
  }
}

async function reconcileLibraryTierForServerUnchecked(
  serverId: string,
  shouldContinue: () => boolean,
): Promise<LibraryTierReconcileResult> {
  const serverIndexKey = serverIndexKeyForServerId(serverId);
  const lp = useLocalPlaybackStore.getState();
  const keepPaths = new Set<string>();
  let syncedFromDisk = 0;
  let removedStaleIndex = 0;

  const candidates = collectCandidateTrackIds(serverId);
  const diskImport = await importLibraryTierFromDisk(serverId, candidates, shouldContinue);
  syncedFromDisk += diskImport.imported;
  for (const hit of diskImport.hits) {
    keepPaths.add(hit.path);
  }

  for (const entry of libraryEntriesForServer(serverId)) {
    if (!shouldContinue()) break;
    const hit = diskImport.hitByTrackId.get(entry.trackId);
    if (hit) {
      keepPaths.add(hit.path);
      continue;
    }
    lp.removeEntry(entry.trackId, entry.serverIndexKey, 'reconcile-missing-bytes');
    removedStaleIndex += 1;
  }

  let orphansRemoved: number;
  try {
    if (!shouldContinue()) return { syncedFromDisk, removedStaleIndex, orphansRemoved: 0 };
    const removed = await pruneOrphanLibraryTierFiles({
      serverIndexKey,
      keepPaths: [...keepPaths],
      mediaDir: getMediaDir(),
    });
    orphansRemoved = removed.length;
  } catch {
    orphansRemoved = 0;
  }

  return { syncedFromDisk, removedStaleIndex, orphansRemoved };
}

export async function reconcileLibraryTierForServer(
  serverId: string,
  shouldContinue: () => boolean = () => true,
): Promise<LibraryTierReconcileResult> {
  const serverIndexKey = serverIndexKeyForServerId(serverId);
  return runOfflineServerMaintenance(
    serverIndexKey,
    () => reconcileLibraryTierForServerUnchecked(serverId, shouldContinue),
  );
}

/** Album-scoped reconcile: sync index ↔ disk for the current track list, then prune orphans. */
async function reconcileLibraryTierForAlbumUnchecked(
  serverId: string,
  songs: SubsonicSong[],
  pinSource?: PinSource,
): Promise<LibraryTierReconcileResult> {
  const serverIndexKey = serverIndexKeyForServerId(serverId);
  const libraryServerId = librarySqlServerId(serverId);
  const lp = useLocalPlaybackStore.getState();
  const keepPaths = new Set<string>();
  let syncedFromDisk = 0;
  let removedStaleIndex = 0;

  await libraryUpsertSongsFromApi(libraryServerId, songs).catch(() => {});

  const candidates = collectCandidateTrackIds(serverId, songs.map(song => song.id));
  const diskImport = await importLibraryTierFromDisk(serverId, candidates);

  for (const song of songs) {
    const hit = diskImport.hitByTrackId.get(song.id);
    const existing = findLocalPlaybackEntry(song.id, serverId);
    if (hit) {
      keepPaths.add(hit.path);
      const effectivePin = pinSource ?? existing?.pinSource;
      if (
        !existing
        || existing.localPath !== hit.path
        || existing.layoutFingerprint !== hit.layoutFingerprint
        || existing.serverIndexKey !== serverIndexKey
      ) {
        await upsertFromProbe(
          {
            path: hit.path,
            size: hit.size,
            layoutFingerprint: hit.layoutFingerprint,
            exists: true,
          },
          serverIndexKey,
          serverId,
          song.id,
          hit.suffix || song.suffix || 'mp3',
          effectivePin,
          existing ? localPlaybackPinSources(existing) : undefined,
        );
        syncedFromDisk += 1;
      }
      continue;
    }
    if (existing) {
      lp.removeEntry(song.id, existing.serverIndexKey, 'reconcile-album-missing-bytes');
      removedStaleIndex += 1;
    }
  }

  for (const hit of diskImport.hits) {
    keepPaths.add(hit.path);
  }

  let orphansRemoved: number;
  try {
    const removed = await pruneOrphanLibraryTierFiles({
      serverIndexKey,
      keepPaths: [...keepPaths],
      mediaDir: getMediaDir(),
    });
    orphansRemoved = removed.length;
  } catch {
    orphansRemoved = 0;
  }

  return { syncedFromDisk, removedStaleIndex, orphansRemoved };
}

export async function reconcileLibraryTierForAlbum(
  serverId: string,
  songs: SubsonicSong[],
  pinSource?: PinSource,
): Promise<LibraryTierReconcileResult> {
  const serverIndexKey = serverIndexKeyForServerId(serverId);
  return runOfflineServerMaintenance(
    serverIndexKey,
    () => reconcileLibraryTierForAlbumUnchecked(serverId, songs, pinSource),
  );
}
