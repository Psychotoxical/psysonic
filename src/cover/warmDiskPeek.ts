import { coverCachePeekBatch } from '../api/coverCache';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { coverEnsureQueued } from './ensureQueue';
import { getDiskSrcForGrid, rememberGridDiskSrc } from './diskSrcLookup';
import { albumCoverRef } from './ref';
import { resolveAlbumCoverRefFromLibrary } from './resolveEntryLibrary';
import { coverStorageKeyFromRef } from './storageKeys';
import { resolveCoverDisplayTier } from './tiers';
import type { CoverArtRef, CoverArtTier, CoverSurfaceKind } from './types';

export type CoverWarmItem = {
  ref: CoverArtRef;
  tier: CoverArtTier;
  storageKey: string;
};

/** @deprecated Sync fallback — prefer {@link coverWarmItemFromLibrary}. */
export function coverWarmItem(
  albumId: string,
  fetchCoverArtId: string,
  displayCssPx: number,
  surface: CoverSurfaceKind = 'dense',
): CoverWarmItem {
  const ref = albumCoverRef(albumId, fetchCoverArtId);
  const tier = resolveCoverDisplayTier(displayCssPx, { surface });
  return {
    ref,
    tier,
    storageKey: coverStorageKeyFromRef(ref, tier),
  };
}

export async function coverWarmItemFromLibrary(
  albumId: string,
  fetchCoverArtId: string,
  displayCssPx: number,
  surface: CoverSurfaceKind = 'dense',
): Promise<CoverWarmItem> {
  const ref = await resolveAlbumCoverRefFromLibrary(albumId, fetchCoverArtId);
  const tier = resolveCoverDisplayTier(displayCssPx, { surface });
  return {
    ref,
    tier,
    storageKey: coverStorageKeyFromRef(ref, tier),
  };
}

export function collectAlbumCoverWarmItems(
  albums: ReadonlyArray<{ id?: string; coverArt?: string | null }>,
  displayCssPx: number,
  surface: CoverSurfaceKind = 'dense',
  limit = 96,
): CoverWarmItem[] {
  const out: CoverWarmItem[] = [];
  for (const a of albums) {
    if (out.length >= limit) break;
    const entityId = a.id ?? a.coverArt;
    if (!entityId) continue;
    // Grid warm/peek uses API coverArt ids — avoids N sequential library_resolve IPC.
    out.push(coverWarmItem(entityId, a.coverArt ?? entityId, displayCssPx, surface));
  }
  return out;
}

export async function collectSongCoverWarmItems(
  songs: ReadonlyArray<{ albumId?: string; coverArt?: string | null }>,
  displayCssPx: number,
  surface: CoverSurfaceKind = 'dense',
  limit = 96,
): Promise<CoverWarmItem[]> {
  const out: CoverWarmItem[] = [];
  for (const s of songs) {
    if (!s.albumId || out.length >= limit) break;
    out.push(
      await coverWarmItemFromLibrary(s.albumId, s.coverArt ?? s.albumId, displayCssPx, surface),
    );
  }
  return out;
}

/**
 * One IPC round-trip: seed `diskSrcCache` from existing `.webp` before cells hit the ensure queue.
 */
export async function warmCoverDiskSrcBatch(items: CoverWarmItem[]): Promise<number> {
  if (items.length === 0) return 0;

  const hits = await coverCachePeekBatch(
    items.map(item => item.ref),
    items[0]!.tier,
  );

  let warmed = 0;
  for (const item of items) {
    const path = hits[item.storageKey];
    if (path && rememberGridDiskSrc(item.ref, item.tier, path)) {
      warmed += 1;
    }
  }
  return warmed;
}

/** High-priority ensure for albums still missing disk `src` after peek. */
export async function ensureAlbumCoverMisses(
  albums: ReadonlyArray<{ id?: string; coverArt?: string | null }>,
  displayCssPx: number,
  opts?: { surface?: CoverSurfaceKind; limit?: number },
): Promise<void> {
  const surface = opts?.surface ?? 'dense';
  const limit = opts?.limit ?? albums.length;
  const tier = resolveCoverDisplayTier(displayCssPx, { surface });
  const slice = albums.slice(0, limit);

  const needEnsure: Array<{ ref: CoverArtRef }> = [];
  for (const album of slice) {
    const entityId = album.id ?? album.coverArt;
    if (!entityId) continue;
    const coverArt = album.coverArt ?? entityId;
    const ref = albumCoverRef(entityId, coverArt);
    if (!getDiskSrcForGrid(ref, tier)) {
      needEnsure.push({ ref });
    }
  }
  if (needEnsure.length === 0) return;

  const PRIME_CHUNK = 8;
  for (let i = 0; i < needEnsure.length; i += PRIME_CHUNK) {
    const chunk = needEnsure.slice(i, i + PRIME_CHUNK);
    await Promise.all(
      chunk.map(async ({ ref }) => {
        const key = coverStorageKeyFromRef(ref, tier);
        const result = await coverEnsureQueued(key, ref, tier, 'middle');
        if (result.hit && result.path) {
          rememberGridDiskSrc(ref, tier, result.path);
        }
      }),
    );
  }
}

/**
 * Peek + high-priority ensure so cards paint with `src` on first frame.
 */
export async function primeAlbumCoversForDisplay(
  albums: ReadonlyArray<{ id?: string; coverArt?: string | null }>,
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
  discoverSongs?: Array<{ albumId?: string; coverArt?: string | null }>;
}): Promise<void> {
  const items = dedupeWarmItems([
    ...collectAlbumCoverWarmItems(snapshot.heroAlbums, 220, 'dense', 12),
    ...collectAlbumCoverWarmItems(snapshot.recent, 300, 'dense', 24),
    ...collectAlbumCoverWarmItems(snapshot.random, 300, 'dense', 24),
    ...collectAlbumCoverWarmItems(snapshot.mostPlayed, 300, 'dense', 20),
    ...collectAlbumCoverWarmItems(snapshot.recentlyPlayed, 300, 'dense', 20),
    ...collectAlbumCoverWarmItems(snapshot.starred, 300, 'dense', 20),
    ...(await collectSongCoverWarmItems(snapshot.discoverSongs ?? [], 200, 'dense', 20)),
  ]);
  await warmCoverDiskSrcBatch(items);

  const discoverSongsForEnsure = snapshot.discoverSongs ?? [];
  await Promise.allSettled([
    ensureAlbumCoverMisses(snapshot.heroAlbums, 220, { surface: 'dense', limit: 8 }),
    ensureAlbumCoverMisses(snapshot.recent, 300, { surface: 'dense', limit: 14 }),
    ensureAlbumCoverMisses(snapshot.random, 300, { surface: 'dense', limit: 10 }),
    ensureAlbumCoverMisses(
      discoverSongsForEnsure.filter(s => s.albumId).map(s => ({ id: s.albumId!, coverArt: s.coverArt })),
      200,
      { surface: 'dense', limit: 12 },
    ),
  ]);

  void predecodeWarmAlbums(snapshot.heroAlbums, 220, 8);
  void predecodeWarmAlbums(snapshot.recent, 300, 10);
  void predecodeWarmAlbums(snapshot.random, 300, 8);
  void predecodeWarmAlbums(
    discoverSongsForEnsure.filter(s => s.albumId).map(s => ({ id: s.albumId!, coverArt: s.coverArt })),
    200,
    8,
  );
}

async function predecodeWarmAlbums(
  albums: ReadonlyArray<{ id?: string; coverArt?: string | null }>,
  displayCssPx: number,
  limit: number,
): Promise<void> {
  if (typeof window === 'undefined') return;
  const tier = resolveCoverDisplayTier(displayCssPx, { surface: 'dense' });
  const urls: string[] = [];
  for (const album of albums) {
    if (!album.coverArt || urls.length >= limit) continue;
    const entityId = album.id ?? album.coverArt;
    if (!entityId) continue;
    const ref = albumCoverRef(entityId, album.coverArt);
    const src = getDiskSrcForGrid(ref, tier);
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
