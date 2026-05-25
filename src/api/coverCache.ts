import { invoke } from '@tauri-apps/api/core';
import { useAuthStore } from '../store/authStore';
import { coverIndexKeyFromRef } from '../cover/storageKeys';
import { restBaseFromUrl } from './subsonicClient';
import type { CoverArtRef, CoverArtTier } from '../cover/types';

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
    return {
      serverIndexKey: coverIndexKeyFromRef(ref),
      coverArtId: ref.coverArtId,
      tier,
      restBaseUrl: coverCacheRestHost(scope.url),
      username: scope.username,
      password: scope.password,
    };
  }
  const server = getActiveServer();
  const baseUrl = getBaseUrl();
  return {
    serverIndexKey: coverIndexKeyFromRef(ref),
    coverArtId: ref.coverArtId,
    tier,
    restBaseUrl: baseUrl,
    username: server?.username ?? '',
    password: server?.password ?? '',
  };
}

export type CoverCachePeekItem = {
  serverIndexKey: string;
  coverArtId: string;
  tier: CoverArtTier;
};

/** Disk-only — no HTTP. Returns map storageKey → absolute .webp path. */
export async function coverCachePeekBatch(
  items: CoverCachePeekItem[],
): Promise<Record<string, string>> {
  if (items.length === 0) return {};
  const raw = await invoke<Record<string, string>>('cover_cache_peek_batch', { items });
  const out: Record<string, string> = {};
  for (const item of items) {
    const key = `${item.serverIndexKey}:cover:${item.coverArtId}:${item.tier}`;
    if (raw[key]) out[key] = raw[key];
  }
  return out;
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
  priority?: string,
): Promise<void> {
  for (const ref of refs) {
    await coverCacheEnsure(ref, tier, priority);
  }
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
  serverIndexKey: string,
  libraryServerId: string,
  cursor?: string | null,
  limit?: number,
): Promise<{ coverIds: string[]; nextCursor: string | null; exhausted: boolean }> {
  return invoke('library_cover_backfill_batch', {
    serverIndexKey,
    libraryServerId,
    cursor,
    limit,
  });
}

export async function libraryCoverProgress(
  serverIndexKey: string,
  libraryServerId: string,
): Promise<{ totalDistinct: number; pending: number; done: number }> {
  return invoke('library_cover_progress', { serverIndexKey, libraryServerId });
}

export function coverCacheMayBackgroundDownload(): boolean {
  return coverAutoDownloadEnabled;
}
