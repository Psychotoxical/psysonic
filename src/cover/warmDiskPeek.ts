import { coverCachePeekBatch } from '../api/coverCache';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { coverEnsureQueued } from './ensureQueue';
import { getDiskSrcForGrid, rememberGridDiskSrc } from './diskSrcLookup';
import { coverArtRef } from './ref';
import { coverIndexKeyFromRef, coverStorageKey } from './storageKeys';
import { resolveCoverDisplayTier } from './tiers';
import type { CoverArtRef, CoverArtTier, CoverSurfaceKind } from './types';

export type CoverWarmItem = {
  ref: CoverArtRef;
  tier: CoverArtTier;
  storageKey: string;
};

export function coverWarmItem(
  coverArtId: string,
  displayCssPx: number,
  surface: CoverSurfaceKind = 'dense',
): CoverWarmItem {
  const ref = coverArtRef(coverArtId);
  const tier = resolveCoverDisplayTier(displayCssPx, { surface });
  return {
    ref,
    tier,
    storageKey: coverStorageKey(ref.serverScope, ref.coverArtId, tier),
  };
}

export function collectAlbumCoverWarmItems(
  albums: ReadonlyArray<{ coverArt?: string | null }>,
  displayCssPx: number,
  surface: CoverSurfaceKind = 'dense',
  limit = 96,
): CoverWarmItem[] {
  const out: CoverWarmItem[] = [];
  for (const a of albums) {
    if (!a.coverArt || out.length >= limit) break;
    out.push(coverWarmItem(a.coverArt, displayCssPx, surface));
  }
  return out;
}

/**
 * One IPC round-trip: seed `diskSrcCache` from existing `.webp` before cells hit the ensure queue.
 */
export async function warmCoverDiskSrcBatch(items: CoverWarmItem[]): Promise<number> {
  if (items.length === 0) return 0;

  const hits = await coverCachePeekBatch(
    items.map(item => ({
      serverIndexKey: coverIndexKeyFromRef(item.ref),
      coverArtId: item.ref.coverArtId,
      tier: item.tier,
    })),
  );

  let warmed = 0;
  for (const item of items) {
    const path = hits[item.storageKey];
    if (
      path
      && rememberGridDiskSrc(item.ref.serverScope, item.ref.coverArtId, item.tier, path)
    ) {
      warmed += 1;
    }
  }
  return warmed;
}

/** High-priority ensure for albums still missing disk `src` after peek. */
export async function ensureAlbumCoverMisses(
  albums: ReadonlyArray<{ coverArt?: string | null }>,
  displayCssPx: number,
  opts?: { surface?: CoverSurfaceKind; limit?: number },
): Promise<void> {
  const surface = opts?.surface ?? 'dense';
  const limit = opts?.limit ?? albums.length;
  const tier = resolveCoverDisplayTier(displayCssPx, { surface });
  const slice = albums.slice(0, limit);

  const needEnsure = slice.filter(album => {
    if (!album.coverArt) return false;
    return !getDiskSrcForGrid({ kind: 'active' }, album.coverArt, tier);
  });
  if (needEnsure.length === 0) return;

  const PRIME_CHUNK = 8;
  for (let i = 0; i < needEnsure.length; i += PRIME_CHUNK) {
    const chunk = needEnsure.slice(i, i + PRIME_CHUNK);
    await Promise.all(
      chunk.map(async album => {
        const id = album.coverArt!;
        const ref = coverArtRef(id);
        const key = coverStorageKey(ref.serverScope, ref.coverArtId, tier);
        const result = await coverEnsureQueued(key, ref, tier, 'high');
        if (result.hit && result.path) {
          rememberGridDiskSrc(ref.serverScope, ref.coverArtId, tier, result.path);
        }
      }),
    );
  }
}

/**
 * Peek + high-priority ensure so cards paint with `src` on first frame.
 */
export async function primeAlbumCoversForDisplay(
  albums: ReadonlyArray<{ coverArt?: string | null }>,
  displayCssPx: number,
  opts?: { surface?: CoverSurfaceKind; limit?: number; disabled?: boolean },
): Promise<void> {
  if (opts?.disabled) return;
  const surface = opts?.surface ?? 'dense';
  const limit = opts?.limit ?? albums.length;
  const items = collectAlbumCoverWarmItems(albums, displayCssPx, surface, limit);
  if (items.length === 0) return;

  await warmCoverDiskSrcBatch(items);
  await ensureAlbumCoverMisses(albums, displayCssPx, { surface, limit });
}

function dedupeWarmItems(items: CoverWarmItem[]): CoverWarmItem[] {
  const seen = new Set<string>();
  const out: CoverWarmItem[] = [];
  for (const item of items) {
    if (seen.has(item.storageKey)) continue;
    seen.add(item.storageKey);
    out.push(item);
  }
  return out;
}

export async function warmHomeMainstageCovers(snapshot: {
  heroAlbums: SubsonicAlbum[];
  recent: SubsonicAlbum[];
  random: SubsonicAlbum[];
  mostPlayed: SubsonicAlbum[];
  recentlyPlayed: SubsonicAlbum[];
  starred: SubsonicAlbum[];
  discoverSongs?: Array<{ coverArt?: string | null }>;
}): Promise<void> {
  const items = dedupeWarmItems([
    ...collectAlbumCoverWarmItems(snapshot.heroAlbums, 220, 'dense', 12),
    ...collectAlbumCoverWarmItems(snapshot.recent, 300, 'dense', 24),
    ...collectAlbumCoverWarmItems(snapshot.random, 300, 'dense', 24),
    ...collectAlbumCoverWarmItems(snapshot.mostPlayed, 300, 'dense', 20),
    ...collectAlbumCoverWarmItems(snapshot.recentlyPlayed, 300, 'dense', 20),
    ...collectAlbumCoverWarmItems(snapshot.starred, 300, 'dense', 20),
    ...collectAlbumCoverWarmItems(snapshot.discoverSongs ?? [], 200, 'dense', 20),
  ]);
  await warmCoverDiskSrcBatch(items);

  // Prepare above-the-fold mainstage covers ahead of return navigation:
  // if a refreshed snapshot introduces new albums not yet on disk, ensure them
  // now in background so Hero / first rows don't wait on per-cell ensure.
  await Promise.allSettled([
    ensureAlbumCoverMisses(snapshot.heroAlbums, 220, { surface: 'dense', limit: 8 }),
    ensureAlbumCoverMisses(snapshot.recent, 300, { surface: 'dense', limit: 14 }),
    ensureAlbumCoverMisses(snapshot.random, 300, { surface: 'dense', limit: 10 }),
  ]);

  // Fire-and-forget decode warmup to reduce first-paint "from cache" delay.
  void predecodeWarmAlbums(snapshot.heroAlbums, 220, 8);
  void predecodeWarmAlbums(snapshot.recent, 300, 10);
  void predecodeWarmAlbums(snapshot.random, 300, 8);
}

async function predecodeWarmAlbums(
  albums: ReadonlyArray<{ coverArt?: string | null }>,
  displayCssPx: number,
  limit: number,
): Promise<void> {
  if (typeof window === 'undefined') return;
  const tier = resolveCoverDisplayTier(displayCssPx, { surface: 'dense' });
  const urls: string[] = [];
  for (const album of albums) {
    if (!album.coverArt || urls.length >= limit) continue;
    const src = getDiskSrcForGrid({ kind: 'active' }, album.coverArt, tier);
    if (!src) continue;
    urls.push(src);
  }
  if (urls.length === 0) return;

  await Promise.allSettled(
    urls.map(
      src =>
        new Promise<void>(resolve => {
          const img = new Image();
          img.decoding = 'async';
          img.src = src;
          if (img.complete) {
            resolve();
            return;
          }
          img.onload = () => resolve();
          img.onerror = () => resolve();
          if ('decode' in img) {
            void (img as HTMLImageElement).decode().then(resolve).catch(resolve);
          }
        }),
    ),
  );
}
