import type { ServerProfile } from './authStoreTypes';
import type { HotCacheEntry } from '@/features/playback/store/hotCacheStoreTypes';
import { localPlaybackEntryKey } from './localPlaybackKeys';
import type { LocalPlaybackEntry, PinSource } from './localPlaybackStore';
import type { OfflineAlbumMeta, OfflineTrackMeta } from '@/features/offline';
import { resolveIndexKey } from '@/lib/server/serverIndexKey';

const MIGRATION_FLAG = 'psysonic-local-playback-migrated-v1';

export function legacyMigrationAlreadyDone(): boolean {
  try {
    return localStorage.getItem(MIGRATION_FLAG) === '1';
  } catch {
    return false;
  }
}

export function markLegacyMigrationDone(): void {
  try {
    localStorage.setItem(MIGRATION_FLAG, '1');
  } catch { /* ignore */ }
}

function resolveIndexKeyForServerId(serverId: string, servers: ServerProfile[]): string {
  const trimmed = serverId.trim();
  if (!trimmed) return trimmed;
  const byId = servers.find(s => s.id === trimmed);
  if (byId) return resolveIndexKey(byId.id) || trimmed;
  return resolveIndexKey(trimmed) || trimmed;
}

type LegacyOfflineBlob = {
  state?: {
    tracks?: Record<string, OfflineTrackMeta>;
    albums?: Record<string, OfflineAlbumMeta>;
  };
};

type LegacyHotBlob = {
  state?: {
    entries?: Record<string, HotCacheEntry>;
  };
};

function pinSourceForTrack(
  serverKey: string,
  trackId: string,
  albums: Record<string, OfflineAlbumMeta>,
): PinSource | undefined {
  for (const album of Object.values(albums)) {
    if (album.serverId !== serverKey && resolveIndexKey(album.serverId) !== serverKey) continue;
    if (!album.trackIds.includes(trackId)) continue;
    return {
      kind: album.type ?? 'album',
      sourceId: album.id,
      displayName: album.name,
    };
  }
  return undefined;
}

/** One-time import from `psysonic-offline` + `psysonic-hot-cache` persist keys. */
export function importLegacyLocalPlayback(
  servers: ServerProfile[],
): Record<string, LocalPlaybackEntry> {
  const out: Record<string, LocalPlaybackEntry> = {};

  try {
    const offlineRaw = localStorage.getItem('psysonic-offline');
    if (offlineRaw) {
      const blob = JSON.parse(offlineRaw) as LegacyOfflineBlob;
      const tracks = blob.state?.tracks ?? {};
      const albums = blob.state?.albums ?? {};
      for (const [key, meta] of Object.entries(tracks)) {
        const colon = key.indexOf(':');
        if (colon <= 0 || !meta?.localPath) continue;
        const legacyServer = key.slice(0, colon);
        const trackId = key.slice(colon + 1);
        const serverIndexKey = resolveIndexKeyForServerId(legacyServer, servers);
        const entryKey = localPlaybackEntryKey(serverIndexKey, trackId);
        out[entryKey] = {
          serverIndexKey,
          trackId,
          localPath: meta.localPath,
          layoutFingerprint: '',
          sizeBytes: 0,
          tier: 'library',
          cachedAt: Date.parse(meta.cachedAt) || Date.now(),
          pinSource: pinSourceForTrack(serverIndexKey, trackId, albums)
            ?? pinSourceForTrack(legacyServer, trackId, albums),
          suffix: meta.suffix || 'mp3',
        };
      }
    }
  } catch { /* ignore corrupt legacy blob */ }

  try {
    const hotRaw = localStorage.getItem('psysonic-hot-cache');
    if (hotRaw) {
      const blob = JSON.parse(hotRaw) as LegacyHotBlob;
      const entries = blob.state?.entries ?? {};
      for (const [key, meta] of Object.entries(entries)) {
        const colon = key.indexOf(':');
        if (colon <= 0 || !meta?.localPath) continue;
        const legacyServer = key.slice(0, colon);
        const trackId = key.slice(colon + 1);
        const serverIndexKey = resolveIndexKeyForServerId(legacyServer, servers);
        const entryKey = localPlaybackEntryKey(serverIndexKey, trackId);
        if (out[entryKey]?.tier === 'library') continue;
        out[entryKey] = {
          serverIndexKey,
          trackId,
          localPath: meta.localPath,
          layoutFingerprint: '',
          sizeBytes: meta.sizeBytes ?? 0,
          tier: 'ephemeral',
          cachedAt: meta.cachedAt ?? Date.now(),
          lastPlayedAt: meta.lastPlayedAt,
          suffix: 'mp3',
        };
      }
    }
  } catch { /* ignore */ }

  return out;
}
