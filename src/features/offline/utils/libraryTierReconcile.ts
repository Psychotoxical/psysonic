import { libraryUpsertSongsFromApi } from '@/lib/api/library';
import { librarySqlServerId } from '@/lib/api/coverCache';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { useAuthStore } from '@/store/authStore';
import type { LocalPlaybackEntry, PinSource } from '@/store/localPlaybackStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
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
  canonicalIdentityGeneration,
  canonicalIdentityGenerationChanged,
} from '@/lib/server/navidromeCanonicalIds';

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

const reconcileTailByServer = new Map<string, Promise<unknown>>();

async function serializeReconcile<T>(serverId: string, run: () => Promise<T>): Promise<T> {
  const previous = reconcileTailByServer.get(serverId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(run);
  reconcileTailByServer.set(serverId, current);
  try {
    return await current;
  } finally {
    if (reconcileTailByServer.get(serverId) === current) reconcileTailByServer.delete(serverId);
  }
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

function upsertFromProbe(
  probe: LibraryTrackProbeResult,
  serverIndexKey: string,
  serverId: string,
  trackId: string,
  suffix: string,
  pinSource?: PinSource,
): void {
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
    suffix,
  });
}

async function discoverLibraryTierHits(
  serverId: string,
  candidateTrackIds: string[],
): Promise<LibraryTierDiskHit[]> {
  const serverIndexKey = serverIndexKeyForServerId(serverId);
  const libraryServerId = librarySqlServerId(serverId);
  return discoverLibraryTierOnDisk({
    serverIndexKey,
    libraryServerId,
    candidateTrackIds,
    mediaDir: getMediaDir(),
  });
}

async function importLibraryTierFromDisk(
  serverId: string,
  candidateTrackIds: string[],
  identityGeneration: number,
): Promise<{
  hits: LibraryTierDiskHit[];
  hitByTrackId: Map<string, LibraryTierDiskHit>;
}> {
  const serverIndexKey = serverIndexKeyForServerId(serverId);
  const hits = await discoverLibraryTierHits(serverId, candidateTrackIds);
  if (canonicalIdentityGenerationChanged(serverIndexKey, identityGeneration)) {
    return { hits: [], hitByTrackId: new Map() };
  }
  const hitByTrackId = new Map(hits.map(hit => [hit.trackId, hit]));
  return { hits, hitByTrackId };
}

function applyDiskImports(
  serverId: string,
  serverIndexKey: string,
  hits: LibraryTierDiskHit[],
  entriesAtStart: Map<string, LocalPlaybackEntry | null>,
): number {
  let imported = 0;
  for (const hit of hits) {
    const existing = findLocalPlaybackEntry(hit.trackId, serverId);
    if (existing !== (entriesAtStart.get(hit.trackId) ?? null)) continue;
    if (
      existing
      && existing.localPath === hit.path
      && existing.layoutFingerprint === hit.layoutFingerprint
      && existing.sizeBytes === hit.size
      && existing.serverIndexKey === serverIndexKey
    ) continue;
    upsertFromProbe(
      { path: hit.path, size: hit.size, layoutFingerprint: hit.layoutFingerprint, exists: true },
      serverIndexKey,
      serverId,
      hit.trackId,
      hit.suffix || 'mp3',
      existing?.pinSource,
    );
    imported += 1;
  }
  return imported;
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

export async function reconcileLibraryTierForServer(
  serverId: string,
): Promise<LibraryTierReconcileResult> {
  return serializeReconcile(serverId, () => reconcileLibraryTierForServerInner(serverId));
}

async function reconcileLibraryTierForServerInner(
  serverId: string,
): Promise<LibraryTierReconcileResult> {
  const serverIndexKey = serverIndexKeyForServerId(serverId);
  const identityGeneration = canonicalIdentityGeneration(serverIndexKey);
  const lp = useLocalPlaybackStore.getState();
  const keepPaths = new Set<string>();
  let syncedFromDisk = 0;
  let removedStaleIndex = 0;
  const entriesAtStartList = libraryEntriesForServer(serverId);
  const entriesAtStart = new Map(entriesAtStartList.map(entry => [entry.trackId, entry]));

  const candidates = collectCandidateTrackIds(serverId);
  let diskImport;
  try {
    diskImport = await importLibraryTierFromDisk(serverId, candidates, identityGeneration);
  } catch {
    return { syncedFromDisk: 0, removedStaleIndex: 0, orphansRemoved: 0 };
  }
  if (canonicalIdentityGenerationChanged(serverIndexKey, identityGeneration)) {
    return { syncedFromDisk: 0, removedStaleIndex: 0, orphansRemoved: 0 };
  }
  syncedFromDisk += applyDiskImports(serverId, serverIndexKey, diskImport.hits, entriesAtStart);
  for (const hit of diskImport.hits) {
    keepPaths.add(hit.path);
  }

  for (const entry of entriesAtStartList) {
    const hit = diskImport.hitByTrackId.get(entry.trackId);
    if (hit) {
      keepPaths.add(hit.path);
      continue;
    }
    const current = findLocalPlaybackEntry(entry.trackId, serverId);
    if (current !== entry) continue;
    lp.removeEntry(current.trackId, current.serverIndexKey, 'reconcile-missing-bytes');
    removedStaleIndex += 1;
  }

  for (const entry of libraryEntriesForServer(serverId)) keepPaths.add(entry.localPath);

  let orphansRemoved: number;
  try {
    if (canonicalIdentityGenerationChanged(serverIndexKey, identityGeneration)) {
      return { syncedFromDisk, removedStaleIndex, orphansRemoved: 0 };
    }
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

/** Album-scoped reconcile: sync index ↔ disk for the current track list, then prune orphans. */
export async function reconcileLibraryTierForAlbum(
  serverId: string,
  songs: SubsonicSong[],
  pinSource?: PinSource,
): Promise<LibraryTierReconcileResult> {
  return serializeReconcile(
    serverId,
    () => reconcileLibraryTierForAlbumInner(serverId, songs, pinSource),
  );
}

async function reconcileLibraryTierForAlbumInner(
  serverId: string,
  songs: SubsonicSong[],
  pinSource?: PinSource,
): Promise<LibraryTierReconcileResult> {
  const serverIndexKey = serverIndexKeyForServerId(serverId);
  const identityGeneration = canonicalIdentityGeneration(serverIndexKey);
  const libraryServerId = librarySqlServerId(serverId);
  const lp = useLocalPlaybackStore.getState();
  const keepPaths = new Set<string>();
  let syncedFromDisk = 0;
  let removedStaleIndex = 0;

  await libraryUpsertSongsFromApi(libraryServerId, songs).catch(() => {});
  if (canonicalIdentityGenerationChanged(serverIndexKey, identityGeneration)) {
    return { syncedFromDisk: 0, removedStaleIndex: 0, orphansRemoved: 0 };
  }

  const entriesAtStart = new Map(
    songs.map(song => [song.id, findLocalPlaybackEntry(song.id, serverId)]),
  );
  const candidates = collectCandidateTrackIds(serverId, songs.map(song => song.id));
  let diskImport;
  try {
    diskImport = await importLibraryTierFromDisk(serverId, candidates, identityGeneration);
  } catch {
    return { syncedFromDisk: 0, removedStaleIndex: 0, orphansRemoved: 0 };
  }
  if (canonicalIdentityGenerationChanged(serverIndexKey, identityGeneration)) {
    return { syncedFromDisk: 0, removedStaleIndex: 0, orphansRemoved: 0 };
  }

  syncedFromDisk += applyDiskImports(serverId, serverIndexKey, diskImport.hits, entriesAtStart);

  for (const song of songs) {
    const hit = diskImport.hitByTrackId.get(song.id);
    const existing = entriesAtStart.get(song.id) ?? null;
    if (hit) {
      const current = findLocalPlaybackEntry(song.id, serverId);
      if (current !== existing) {
        if (current?.localPath) keepPaths.add(current.localPath);
        continue;
      }
      keepPaths.add(hit.path);
      const effectivePin = pinSource ?? existing?.pinSource;
      if (
        !existing
        || existing.localPath !== hit.path
        || existing.layoutFingerprint !== hit.layoutFingerprint
        || existing.serverIndexKey !== serverIndexKey
        || existing.pinSource?.kind !== effectivePin?.kind
        || existing.pinSource?.sourceId !== effectivePin?.sourceId
        || existing.pinSource?.displayName !== effectivePin?.displayName
      ) {
        upsertFromProbe(
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
        );
        syncedFromDisk += 1;
      }
      continue;
    }
    if (existing) {
      const current = findLocalPlaybackEntry(song.id, serverId);
      if (current !== existing) continue;
      lp.removeEntry(current.trackId, current.serverIndexKey, 'reconcile-album-missing-bytes');
      removedStaleIndex += 1;
    }
  }

  for (const hit of diskImport.hits) {
    keepPaths.add(hit.path);
  }
  for (const entry of libraryEntriesForServer(serverId)) keepPaths.add(entry.localPath);

  let orphansRemoved: number;
  try {
    if (canonicalIdentityGenerationChanged(serverIndexKey, identityGeneration)) {
      return { syncedFromDisk, removedStaleIndex, orphansRemoved: 0 };
    }
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
