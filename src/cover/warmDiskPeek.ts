import { coverCachePeekBatch } from '../api/coverCache';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { coverEnsureQueued, ensureArtistBackdropQueued } from './ensureQueue';
import { getDiskSrcForGrid, rememberGridDiskSrc } from './diskSrcLookup';
import { albumCoverRef, artistCoverRef } from './ref';
import { coverDiskUrl } from './diskSrcCache';
import { resolveAlbumCoverRefFromLibrary } from './resolveEntryLibrary';
import { coverStorageKeyFromRef } from './storageKeys';
import { resolveCoverDisplayTier } from './tiers';
import type { CoverArtRef, CoverArtTier, CoverPrefetchPriority, CoverSurfaceKind } from './types';
import { useThemeStore } from '../store/themeStore';
import { deriveAlbumArtistRefs } from '../utils/album/deriveAlbumHeaderArtistRefs';
import { getHeroBackdropUpgrade, recordHeroBackdropUpgrade } from './heroBackdropMemory';

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

  // Hero artist backdrops (fanart/banner) — prefetch the upcoming slides at
  // slide-index priorities so the higher-priority source is on disk before its
  // slide is shown. Inert when the scraper is off.
  void warmHeroArtistBackdrops(snapshot.heroAlbums);
}

const HERO_BACKDROP_TIER: CoverArtTier = 2000;

/** Static priority at open: slide 1 = next auto-advance (≤10 s) → `high`; slide 0
 *  is already shown via Navidrome → `low`; the rest are lookahead → `middle`.
 *  No recompute on navigation (cucadmuh, 2026-06). */
function heroSlidePriority(idx: number): CoverPrefetchPriority {
  return idx === 1 ? 'high' : idx === 0 ? 'low' : 'middle';
}

/**
 * Prefetch each hero slide's artist backdrop (the configured external surfaces:
 * `banner` / `fanart`) at its slide-index priority, reusing the standard ensure
 * queue (`ensureArtistBackdropQueued` → same dedupe / trim as grid covers). Each
 * disk hit is recorded in the per-album memory so {@link useHeroBackdrop} can
 * paint it on entry. Inert when the scraper is off, the mainstage surface is
 * disabled, or no external source is enabled.
 */
export async function warmHeroArtistBackdrops(
  heroAlbums: ReadonlyArray<SubsonicAlbum>,
): Promise<void> {
  const theme = useThemeStore.getState();
  if (!theme.externalArtworkEnabled) return;
  const cfg = theme.backdrops.mainstageHero;
  if (!cfg.enabled) return;
  const surfaces = cfg.sources
    .filter(s => s.enabled && (s.source === 'banner' || s.source === 'fanart'))
    .map(s => s.source as 'banner' | 'fanart');
  if (surfaces.length === 0) return;

  await Promise.allSettled(
    heroAlbums.flatMap((album, idx) => {
      const artist = deriveAlbumArtistRefs(album)[0];
      if (!artist?.id || !album.id) return [];
      const ref = artistCoverRef(artist.id);
      const priority = heroSlidePriority(idx);
      const albumId = album.id;
      return surfaces.map(surface => {
        const key = `${coverStorageKeyFromRef(ref, HERO_BACKDROP_TIER)}:${surface}`;
        return ensureArtistBackdropQueued(key, ref, surface, priority, {
          artistName: artist.name,
          albumTitle: album.name,
        }).then(res => {
          if (res.hit && res.path) {
            recordHeroBackdropUpgrade(albumId, surface, coverDiskUrl(res.path));
          }
        });
      });
    }),
  );

  void predecodeHeroBackdrops(heroAlbums);
}

/** Decode the on-disk hero backdrop of every slide already warmed, so the first
 *  `HeroBg` paint is hitch-free (Frank, 2026-06: every slide on disk). */
async function predecodeHeroBackdrops(heroAlbums: ReadonlyArray<SubsonicAlbum>): Promise<void> {
  if (typeof window === 'undefined') return;
  const urls: string[] = [];
  for (const album of heroAlbums) {
    const mem = getHeroBackdropUpgrade(album.id);
    const url = mem?.banner ?? mem?.fanart;
    if (url) urls.push(url);
  }
  if (urls.length === 0) return;
  await Promise.allSettled(urls.map(decodeImage));
}

/** Browser-decode an image so it is paint-ready from cache, never throwing. */
function decodeImage(src: string): Promise<void> {
  return new Promise<void>(resolve => {
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
  });
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

  await Promise.allSettled(urls.map(decodeImage));
}
