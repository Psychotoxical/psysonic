import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../store/authStore';
import { coverIndexKeyFromRef, coverStorageKeyFromRef } from '../cover/storageKeys';
import { connectBaseUrlForServer } from '../utils/server/serverEndpoint';
import { serverIndexKeyForProfile } from '../utils/server/serverIndexKey';
import { getPlaybackServerId } from '../utils/playback/playbackServer';
import { restBaseFromUrl } from './subsonicClient';
import type { CoverArtRef, CoverArtTier } from '../cover/types';

/** Library SQLite `track.server_id` uses host index keys, not auth profile UUIDs. */
export function librarySqlServerId(profileOrIndexServerId: string): string {
  const server = useAuthStore.getState().servers.find(s => s.id === profileOrIndexServerId);
  if (server) return serverIndexKeyForProfile(server);
  return profileOrIndexServerId;
}

/** Host root for Rust `build_cover_art_url` (`{host}/rest/getCoverArt.view`). */
export function coverCacheRestHost(serverUrl: string): string {
  return restBaseFromUrl(serverUrl).replace(/\/rest$/i, '');
}

export type CoverCacheEnsureResult = {
  hit: boolean;
  path: string;
  tier: CoverArtTier;
};

export type CoverCacheStats = {
  bytes: number;
  count: number;
  pressure: 'ok' | 'pressure' | 'full';
  autoDownloadEnabled: boolean;
  entryCount: number;
};

let coverAutoDownloadEnabled = true;

export function setCoverCacheAutoDownloadEnabled(enabled: boolean): void {
  coverAutoDownloadEnabled = enabled;
}

function ensureArgsFromRef(ref: CoverArtRef, tier: CoverArtTier) {
  const { getBaseUrl, getActiveServer } = useAuthStore.getState();
  const scope = ref.serverScope;
  if (scope.kind === 'server') {
    // scope.url is the index-stable primary; the Rust cover fetcher needs
    // the runtime connect URL (LAN or public, whichever currently answers).
    return {
      serverIndexKey: coverIndexKeyFromRef(ref),
      cacheKind: ref.cacheKind,
      cacheEntityId: ref.cacheEntityId,
      coverArtId: ref.fetchCoverArtId,
      tier,
      restBaseUrl: coverCacheRestHost(
        connectBaseUrlForServer({ id: scope.serverId, url: scope.url }),
      ),
      username: scope.username,
      password: scope.password,
    };
  }
  const server =
    scope.kind === 'playback'
      ? (() => {
          const playbackServerId = getPlaybackServerId();
          if (playbackServerId) {
            const playbackServer = useAuthStore
              .getState()
              .servers.find(s => s.id === playbackServerId);
            if (playbackServer) return playbackServer;
          }
          return getActiveServer();
        })()
      : getActiveServer();
  const baseUrl = server ? connectBaseUrlForServer(server) : getBaseUrl();
  return {
    serverIndexKey: coverIndexKeyFromRef(ref),
    cacheKind: ref.cacheKind,
    cacheEntityId: ref.cacheEntityId,
    coverArtId: ref.fetchCoverArtId,
    tier,
    restBaseUrl: baseUrl ? coverCacheRestHost(baseUrl) : '',
    username: server?.username ?? '',
    password: server?.password ?? '',
  };
}

export type CoverCachePeekItem = {
  serverIndexKey: string;
  cacheKind: 'album' | 'artist';
  cacheEntityId: string;
  tier: CoverArtTier;
  storageKey: string;
};

/** Disk-only — no HTTP. Returns map storageKey → absolute .webp path. */
export async function coverCachePeekBatch(
  refs: CoverArtRef[],
  tier: CoverArtTier,
): Promise<Record<string, string>> {
  if (refs.length === 0) return {};
  const items: CoverCachePeekItem[] = refs.map(ref => ({
    serverIndexKey: coverIndexKeyFromRef(ref),
    cacheKind: ref.cacheKind,
    cacheEntityId: ref.cacheEntityId,
    tier,
    storageKey: coverStorageKeyFromRef(ref, tier),
  }));
  return invoke<Record<string, string>>('cover_cache_peek_batch', { items });
}

export async function coverCacheEnsure(
  ref: CoverArtRef,
  tier: CoverArtTier,
  _priority?: string,
): Promise<CoverCacheEnsureResult> {
  return invoke<CoverCacheEnsureResult>('cover_cache_ensure', {
    args: ensureArgsFromRef(ref, tier),
  });
}

export async function coverCacheEnsureBatch(
  refs: CoverArtRef[],
  tier: CoverArtTier,
  _priority?: string,
): Promise<void> {
  if (refs.length === 0) return;
  const items = refs.map(ref => ensureArgsFromRef(ref, tier));
  await invoke('cover_cache_ensure_batch', { items });
}

export async function coverCacheStats(): Promise<CoverCacheStats> {
  const stats = await invoke<CoverCacheStats>('cover_cache_stats', {});
  setCoverCacheAutoDownloadEnabled(stats.autoDownloadEnabled);
  return stats;
}

/** Clears all servers (legacy). Prefer `coverCacheClearServer`. */
export async function coverCacheClear(): Promise<void> {
  return invoke('cover_cache_clear', {});
}

export async function coverCacheClearServer(serverIndexKey: string): Promise<void> {
  return invoke('cover_cache_clear_server', { serverIndexKey });
}

export async function coverCacheStatsServer(
  serverIndexKey: string,
): Promise<Pick<CoverCacheStats, 'bytes' | 'entryCount'>> {
  const stats = await invoke<CoverCacheStats>('cover_cache_stats_server', { serverIndexKey });
  return { bytes: stats.bytes, entryCount: stats.entryCount };
}

export async function libraryCoverBackfillBatch(
  serverIndexKey: string,
  libraryServerId: string,
  cursor?: string | null,
  limit?: number,
): Promise<{ coverIds: string[]; nextCursor: string | null; exhausted: boolean }> {
  const sqlServerId = librarySqlServerId(libraryServerId);
  const diskKey = serverIndexKey || sqlServerId;
  return invoke('library_cover_backfill_batch', {
    serverIndexKey: diskKey,
    libraryServerId: sqlServerId,
    cursor,
    limit,
  });
}

export async function libraryCoverProgress(
  serverIndexKey: string,
  libraryServerId: string,
): Promise<{ totalDistinct: number; pending: number; done: number }> {
  const sqlServerId = librarySqlServerId(libraryServerId);
  const diskKey = serverIndexKey || sqlServerId;
  return invoke('library_cover_progress', {
    serverIndexKey: diskKey,
    libraryServerId: sqlServerId,
  });
}

export type LibraryCoverBackfillConfigureArgs = {
  enabled: boolean;
  serverIndexKey: string;
  libraryServerId: string;
  restBaseUrl: string;
  username: string;
  password: string;
};

export async function libraryCoverBackfillConfigure(
  args: LibraryCoverBackfillConfigureArgs,
): Promise<void> {
  return invoke('library_cover_backfill_configure', args);
}

export type CoverBackfillPulseResult = {
  scheduled: number;
  exhausted: boolean;
  pending: number;
  done: number;
  total: number;
  status: 'idle' | 'active' | 'blocked_sync' | 'blocked_pressure' | 'disabled' | string;
};

/** One backfill step (legacy); prefer `libraryCoverBackfillRunFullPass`. */
export async function libraryCoverBackfillPulse(): Promise<CoverBackfillPulseResult> {
  return invoke<CoverBackfillPulseResult>('library_cover_backfill_pulse');
}

/** Start one full-catalog pass on the native runtime (works when the window is inactive). */
export async function libraryCoverBackfillRunFullPass(): Promise<{ started: boolean }> {
  return invoke<{ started: boolean }>('library_cover_backfill_run_full_pass');
}

export async function libraryCoverBackfillResetCursor(): Promise<void> {
  return invoke('library_cover_backfill_reset_cursor');
}

/** Yield native library backfill while the user navigates (visible covers first). */
export async function libraryCoverBackfillSetUiPriority(hold: boolean): Promise<void> {
  return invoke('library_cover_backfill_set_ui_priority', { hold });
}

export async function libraryCoverClearFetchFailures(serverIndexKey: string): Promise<number> {
  return invoke<number>('library_cover_clear_fetch_failures', { serverIndexKey });
}

export async function libraryCoverCatalogSize(libraryServerId: string): Promise<number> {
  return invoke<number>('library_cover_catalog_size', {
    libraryServerId: librarySqlServerId(libraryServerId),
  });
}

export function coverCacheMayBackgroundDownload(): boolean {
  return coverAutoDownloadEnabled;
}
