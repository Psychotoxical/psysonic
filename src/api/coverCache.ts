import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../store/authStore';
import type { CoverArtRef, CoverArtTier } from '../cover/types';

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
    const base = scope.url.replace(/\/+$/, '') + '/rest';
    return {
      serverId: scope.serverId,
      coverArtId: ref.coverArtId,
      tier,
      restBaseUrl: base,
      username: scope.username,
      password: scope.password,
    };
  }
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  return {
    serverId: server?.id ?? '_',
    coverArtId: ref.coverArtId,
    tier,
    restBaseUrl: baseUrl ? `${baseUrl}/rest` : '',
    username: server?.username ?? '',
    password: server?.password ?? '',
  };
}

export async function coverCacheEnsure(
  ref: CoverArtRef,
  tier: CoverArtTier,
  _priority?: string,
): Promise<CoverCacheEnsureResult> {
  return invoke<CoverCacheEnsureResult>('cover_cache_ensure', ensureArgsFromRef(ref, tier));
}

export async function coverCacheEnsureBatch(
  refs: CoverArtRef[],
  tier: CoverArtTier,
  _priority?: string,
): Promise<void> {
  return invoke('cover_cache_ensure_batch', {
    items: refs.map(r => ensureArgsFromRef(r, tier)),
  });
}

export async function coverCacheStats(): Promise<CoverCacheStats> {
  const stats = await invoke<CoverCacheStats>('cover_cache_stats', {});
  setCoverCacheAutoDownloadEnabled(stats.autoDownloadEnabled);
  return stats;
}

export async function coverCacheClear(): Promise<void> {
  return invoke('cover_cache_clear', {});
}

export async function libraryCoverBackfillBatch(
  serverId: string,
  cursor?: string | null,
  limit?: number,
): Promise<{ coverIds: string[]; nextCursor: string | null; exhausted: boolean }> {
  return invoke('library_cover_backfill_batch', { serverId, cursor, limit });
}

export async function libraryCoverProgress(
  serverId: string,
): Promise<{ totalDistinct: number; pending: number; done: number }> {
  return invoke('library_cover_progress', { serverId });
}

export function coverCacheMayBackgroundDownload(): boolean {
  return coverAutoDownloadEnabled;
}
