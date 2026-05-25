import { invoke } from '@tauri-apps/api/core';
import type { CoverArtRef, CoverArtTier } from '../cover/types';

export type CoverCacheEnsureResult = {
  hit: boolean;
  path: string;
  tier: CoverArtTier;
};

export async function coverCacheEnsure(
  _ref: CoverArtRef,
  _tier: CoverArtTier,
  _priority?: string,
): Promise<CoverCacheEnsureResult> {
  return invoke<CoverCacheEnsureResult>('cover_cache_ensure', {});
}

export async function coverCacheEnsureBatch(
  _refs: CoverArtRef[],
  _tier: CoverArtTier,
  _priority?: string,
): Promise<void> {
  return invoke('cover_cache_ensure_batch', {});
}

export async function coverCacheStats(): Promise<{ bytes: number; count: number }> {
  return invoke('cover_cache_stats', {});
}

export async function coverCacheClear(): Promise<void> {
  return invoke('cover_cache_clear', {});
}

export async function libraryCoverBackfillBatch(
  _serverId: string,
  _cursor?: string | null,
  _limit?: number,
): Promise<{ coverIds: string[]; nextCursor: string | null; exhausted: boolean }> {
  return invoke('library_cover_backfill_batch', {});
}

export async function libraryCoverProgress(
  _serverId: string,
): Promise<{ totalDistinct: number; pending: number; done: number }> {
  return invoke('library_cover_progress', {});
}
