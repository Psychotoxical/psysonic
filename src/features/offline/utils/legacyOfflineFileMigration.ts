import { frontendDebugLog } from '@/lib/api/debugLog';
import { libraryGetTracksBatch } from '@/lib/api/library';
import { useAuthStore } from '@/store/authStore';
import { useOfflineStore, type OfflineAlbumMeta } from '@/features/offline/store/offlineStore';
import { useLocalPlaybackStore, type LocalPlaybackEntry, type PinSource } from '@/store/localPlaybackStore';
import { localPlaybackEntryKey } from '@/store/localPlaybackKeys';
import { importLegacyLocalPlayback } from '@/store/localPlaybackMigration';
import { getMediaDir } from '@/lib/media/mediaDir';
import { migrateLegacyOfflineDisk } from '@/lib/api/syncfs';
import { resolveServerIdForIndexKey } from '@/lib/server/serverLookup';
import { resolveIndexKey } from '@/lib/server/serverIndexKey';
import type { LegacyOfflineMigrationResult } from '@/generated/bindings';

type PersistCapableStore = {
  persist: {
    hasHydrated: () => boolean;
    onFinishHydration: (fn: () => void) => () => void;
  };
};

type LegacyOfflineBlob = {
  state?: {
    albums?: Record<string, OfflineAlbumMeta>;
  };
};

function waitForStoreHydration(store: PersistCapableStore): Promise<void> {
  if (store.persist.hasHydrated()) return Promise.resolve();
  return new Promise(resolve => {
    const unsub = store.persist.onFinishHydration(() => {
      unsub();
      resolve();
    });
  });
}

function migrationDebug(payload: Record<string, unknown>): void {
  if (useAuthStore.getState().loggingMode !== 'debug') return;
  frontendDebugLog('legacy-offline-migration', JSON.stringify(payload));
}

function resolveIndexKeyForServerId(serverId: string): string {
  const trimmed = serverId.trim();
  if (!trimmed) return trimmed;
  const servers = useAuthStore.getState().servers;
  const byId = servers.find(s => s.id === trimmed);
  if (byId) return resolveIndexKey(byId.id) || trimmed;
  return resolveIndexKey(trimmed) || trimmed;
}

function collectLegacyOfflineAlbums(): OfflineAlbumMeta[] {
  const merged: Record<string, OfflineAlbumMeta> = {
    ...useOfflineStore.getState().albums,
  };
  try {
    const raw = localStorage.getItem('psysonic-offline');
    if (raw) {
      const blob = JSON.parse(raw) as LegacyOfflineBlob;
      Object.assign(merged, blob.state?.albums ?? {});
    }
  } catch { /* ignore */ }
  return Object.values(merged);
}

function pinSourceForTrack(
  serverIndexKey: string,
  trackId: string,
  albums: OfflineAlbumMeta[],
): PinSource | undefined {
  for (const album of albums) {
    if (!album.trackIds.includes(trackId)) continue;
    const albumKey = resolveIndexKeyForServerId(album.serverId);
    if (albumKey !== serverIndexKey && album.serverId !== serverIndexKey) continue;
    return {
      kind: album.type ?? 'album',
      sourceId: album.id,
      displayName: album.name,
    };
  }
  return undefined;
}

/** True when the file still uses the flat legacy offline layout (not under `media/…/library/`). */
export function entryNeedsFileRelocation(entry: LocalPlaybackEntry): boolean {
  if (entry.tier !== 'library' || !entry.localPath.trim()) return false;
  const normalized = entry.localPath.replace(/\\/g, '/');
  if (normalized.includes('/media/library/')) return false;
  if (normalized.includes('/psysonic-offline/')) return true;
  return !normalized.includes('/library/');
}

/** Offline Library cards need `pinSource` — restore from legacy albums + persist import. */
export function restoreOfflineLibraryPinSources(): number {
  const servers = useAuthStore.getState().servers;
  const albums = collectLegacyOfflineAlbums();
  const fromPersist = importLegacyLocalPlayback(servers);
  const store = useLocalPlaybackStore.getState();
  const merged = { ...store.entries };
  let updated = 0;

  for (const entry of Object.values(merged)) {
    if (entry.tier !== 'library' || entry.pinSource) continue;
    const key = localPlaybackEntryKey(entry.serverIndexKey, entry.trackId);
    const legacy = fromPersist[key];
    const pin = legacy?.pinSource
      ?? pinSourceForTrack(entry.serverIndexKey, entry.trackId, albums);
    if (!pin) continue;
    merged[key] = { ...entry, pinSource: pin };
    updated += 1;
  }

  if (updated > 0) {
    useLocalPlaybackStore.setState({ entries: merged });
  }
  return updated;
}

/** Group orphan library pins by album metadata when legacy cards are gone. */
export async function inferPinSourcesFromLibraryIndex(): Promise<number> {
  const needs = Object.values(useLocalPlaybackStore.getState().entries)
    .filter(e => e.tier === 'library' && !e.pinSource);
  if (needs.length === 0) return 0;

  const refs = needs.map(e => ({
    serverId: resolveServerIdForIndexKey(e.serverIndexKey) || e.serverIndexKey,
    trackId: e.trackId,
  }));
  const tracks = await libraryGetTracksBatch(refs);
  const byRef = new Map(tracks.map(t => [`${t.serverId}:${t.id}`, t]));
  let updated = 0;

  for (const entry of needs) {
    const serverId = resolveServerIdForIndexKey(entry.serverIndexKey) || entry.serverIndexKey;
    const dto = byRef.get(`${serverId}:${entry.trackId}`);
    if (!dto?.albumId) continue;
    useLocalPlaybackStore.getState().upsertEntry({
      ...entry,
      pinSource: {
        kind: 'album',
        sourceId: dto.albumId,
        displayName: dto.album,
      },
    });
    updated += 1;
  }
  return updated;
}

function applyMigrationResults(results: LegacyOfflineMigrationResult[]): number {
  let relocated = 0;
  for (const r of results) {
    if (!r.path || r.skippedReason === 'library_track_not_found') continue;
    const key = localPlaybackEntryKey(r.serverIndexKey, r.trackId);
    const prev = useLocalPlaybackStore.getState().entries[key];
    useLocalPlaybackStore.getState().upsertEntry({
      serverIndexKey: r.serverIndexKey,
      trackId: r.trackId,
      localPath: r.path,
      layoutFingerprint: r.layoutFingerprint || prev?.layoutFingerprint || '',
      sizeBytes: r.size || prev?.sizeBytes || 0,
      tier: 'library',
      cachedAt: prev?.cachedAt ?? Date.now(),
      pinSource: prev?.pinSource,
      suffix: prev?.suffix ?? 'mp3',
    });
    if (r.relocated) relocated += 1;
  }
  return relocated;
}

/**
 * Scan flat `psysonic-offline/{segment}/{trackId}.ext`, keep tracks that still
 * exist in the library index, move them under `media/library/…`, then restore
 * Offline Library grouping (`pinSource`).
 */
export async function runLegacyOfflineFileMigration(serverIndexKey?: string): Promise<number> {
  await waitForStoreHydration(useAuthStore as unknown as PersistCapableStore);
  await waitForStoreHydration(useLocalPlaybackStore as unknown as PersistCapableStore);
  await waitForStoreHydration(useOfflineStore as unknown as PersistCapableStore);

  const customOfflineDir = useAuthStore.getState().offlineDownloadDir?.trim() || null;
  let relocated = 0;
  try {
    const results = await migrateLegacyOfflineDisk({
      mediaDir: getMediaDir(),
      customOfflineDir,
      serverIndexKeyFilter: serverIndexKey ?? null,
    });
    relocated = applyMigrationResults(results);
    migrationDebug({
      event: 'disk-migrate',
      serverIndexKey: serverIndexKey ?? null,
      scanned: results.length,
      relocated,
      results: results.map(r => ({
        trackId: r.trackId,
        relocated: r.relocated,
        skippedReason: r.skippedReason ?? null,
      })),
    });
  } catch (err) {
    migrationDebug({
      event: 'disk-migrate-error',
      serverIndexKey: serverIndexKey ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const fromAlbums = restoreOfflineLibraryPinSources();
  const fromIndex = await inferPinSourcesFromLibraryIndex();
  migrationDebug({
    event: 'pin-source-restore',
    fromAlbums,
    fromIndex,
    groups: useLocalPlaybackStore.getState().listPinnedGroups().length,
  });

  return relocated;
}
