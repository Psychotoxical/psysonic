import { parseSubsonicEntityStarRating, prefetchAlbumUserRatings, prefetchArtistUserRatings } from '../../api/subsonicRatings';
import { getRandomSongs } from '../../api/subsonicLibrary';
import type { SubsonicAlbum, SubsonicSong } from '../../api/subsonicTypes';
import { useAuthStore } from '../../store/authStore';
import { usePlayerStore } from '../../store/playerStore';

/** Default target list size for Random Mix; per-call override via `fetchRandomMixSongsUntilFull(c, { targetSize })`. */
export const RANDOM_MIX_TARGET_SIZE = 50;
/** Subsonic spec caps `getRandomSongs` at 500 per call. */
const RANDOM_MIX_BATCH_HARD_CAP = 500;
const RANDOM_MIX_BATCH_FLOOR = 50;
/** Per-call batch size depends on whether a filter is active.
 *  - No filter: ask for the full target in one call (server ORDER BY random LIMIT N is one query).
 *  - With filter: stick to small 50-track batches — large batches waste bandwidth when only a small
 *    fraction of candidates pass the filter, and they make every loop iteration slow on the server. */
function batchSizeFor(targetSize: number, filterActive: boolean): number {
  if (filterActive) return RANDOM_MIX_BATCH_FLOOR;
  return Math.min(RANDOM_MIX_BATCH_HARD_CAP, Math.max(RANDOM_MIX_BATCH_FLOOR, targetSize));
}
/** Upper bound on `getRandomSongs` calls (avoids infinite loop if the library is tiny or the filter is extreme).
 *  Filtered mode is generous because a selective filter (e.g. only ≥3★ in a library where 5% of tracks are
 *  rated) needs many candidates to find a target's worth of passes. Unfiltered mode just tops up the
 *  fast-path's first call. */
function maxBatchesFor(targetSize: number, batchSize: number, filterActive: boolean): number {
  if (filterActive) {
    return Math.max(40, Math.ceil((targetSize * 8) / batchSize));
  }
  return Math.max(8, Math.ceil((targetSize * 4) / batchSize));
}
/** Stop if several batches in a row bring no new track ids (server keeps repeating the same set).
 *  Scales with target size: at 50 a 6-batch floor is fine; at 150 we tolerate ~25 empty-novel batches
 *  before giving up so libraries with weakly-shuffled random endpoints can still fill the larger requests.
 *  Without this, "All Songs" mixes at 150 stalled around 120–145 while Genre mixes (smaller candidate pool,
 *  lower repeat rate per batch) could reach 150 cleanly. */
function dupStreakBudget(targetSize: number): number {
  return Math.max(8, Math.ceil(targetSize / 6));
}

export interface MixMinRatingsConfig {
  enabled: boolean;
  minSong: number;
  minAlbum: number;
  minArtist: number;
}

export function getMixMinRatingsConfigFromAuth(): MixMinRatingsConfig {
  const s = useAuthStore.getState();
  return {
    enabled: s.mixMinRatingFilterEnabled,
    minSong: s.mixMinRatingSong,
    minAlbum: s.mixMinRatingAlbum,
    minArtist: s.mixMinRatingArtist,
  };
}

function numRating(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

/** Optimistic stars from the UI (`setUserRatingOverride`) take precedence over API payloads. */
function mixRatingOverrideForEntity(entityId: string | undefined): number | undefined {
  if (!entityId) return undefined;
  const o = usePlayerStore.getState().userRatingOverrides[entityId];
  if (o === undefined || o <= 0) return undefined;
  return o;
}

type OpenArtistRefLike = { id?: string; userRating?: unknown; rating?: unknown };

function refStarRating(a: OpenArtistRefLike | undefined): number | undefined {
  return numRating(a?.userRating ?? a?.rating);
}

function ratingFromArtistRefs(
  list: OpenArtistRefLike[] | undefined,
  preferId?: string,
): number | undefined {
  if (!list?.length) return undefined;
  if (preferId) {
    const m = list.find(x => x.id === preferId);
    const r = refStarRating(m);
    if (r !== undefined) return r;
  }
  for (const a of list) {
    const r = refStarRating(a);
    if (r !== undefined) return r;
  }
  return undefined;
}

const CONTRIBUTOR_ROLES_FOR_ARTIST_ID =
  /^(artist|album[\s_-]*artist|performer|track[\s_-]*artist|albumartist)$/i;

/**
 * Entity id for artist-level mix rating: canonical `artistId`, else OpenSubsonic `artists[].id`,
 * else Navidrome `contributors[].artist.id` when list payloads omit the former.
 */
function artistEntityIdForMixRating(song: SubsonicSong): string | undefined {
  if (song.artistId) return song.artistId;
  const fromArtists = song.artists?.find(a => a.id)?.id;
  if (fromArtists) return fromArtists;
  const cList = song.contributors;
  if (cList?.length) {
    const byRole = cList.find(
      c => c.artist?.id && CONTRIBUTOR_ROLES_FOR_ARTIST_ID.test((c.role || '').trim()),
    );
    if (byRole?.artist?.id) return byRole.artist.id;
    const anyId = cList.find(c => c.artist?.id);
    if (anyId?.artist?.id) return anyId.artist.id;
  }
  return undefined;
}

/** Song-level artist rating: explicit field, then OpenSubsonic `artists` / `albumArtists` on the child. */
function effectiveArtistRatingForFilter(song: SubsonicSong): number | undefined {
  const prefer = artistEntityIdForMixRating(song);
  const fromOverride = mixRatingOverrideForEntity(prefer);
  if (fromOverride !== undefined) return fromOverride;
  const d = numRating(song.artistUserRating);
  if (d !== undefined) return d;
  const fromArtists = ratingFromArtistRefs(song.artists, prefer);
  if (fromArtists !== undefined) return fromArtists;
  return ratingFromArtistRefs(song.albumArtists, prefer);
}

/** Song-level album (parent) rating when the server puts it on the child payload. */
function effectiveAlbumRatingOnSong(song: SubsonicSong): number | undefined {
  const fromOverride = mixRatingOverrideForEntity(song.albumId);
  if (fromOverride !== undefined) return fromOverride;
  const x = song as SubsonicSong & { albumRating?: unknown };
  return numRating(song.albumUserRating ?? x.albumRating);
}

function songTrackStarRatingForMix(song: SubsonicSong): number | undefined {
  const fromOverride = mixRatingOverrideForEntity(song.id);
  if (fromOverride !== undefined) return fromOverride;
  const x = song as SubsonicSong & { rating?: unknown };
  return numRating(song.userRating ?? x.rating);
}

/**
 * Random mixes: when enabled, drop items with a **non-zero** rating that is **at or below** the
 * chosen threshold (inclusive). `0` / missing = unrated, never excluded.
 */
export function passesMixMinRatings(song: SubsonicSong, c: MixMinRatingsConfig): boolean {
  if (!c.enabled) return true;
  if (c.minSong > 0) {
    const r = songTrackStarRatingForMix(song);
    if (r !== undefined && r > 0 && r <= c.minSong) return false;
  }
  if (c.minAlbum > 0) {
    const r = effectiveAlbumRatingOnSong(song);
    if (r !== undefined && r > 0 && r <= c.minAlbum) return false;
  }
  if (c.minArtist > 0) {
    const r = effectiveArtistRatingForFilter(song);
    if (r !== undefined && r > 0 && r <= c.minArtist) return false;
  }
  return true;
}

export interface MixAlbumFilterExtra {
  /** From `getArtist` when list payloads omit artist rating. */
  artistUserRating?: number;
  /** From `getAlbum` when list payloads omit album `userRating`. */
  albumUserRating?: number;
}

/**
 * Random album lists: album `userRating` when present; optional extra from entity fetches.
 * Song axis is not on this payload. `0` / missing = unrated, keep.
 */
export function passesMixMinRatingsForAlbum(
  album: SubsonicAlbum,
  c: MixMinRatingsConfig,
  extra?: MixAlbumFilterExtra,
): boolean {
  if (!c.enabled) return true;
  if (c.minAlbum > 0) {
    const r =
      parseSubsonicEntityStarRating(album as SubsonicAlbum & { rating?: unknown })
      ?? numRating(extra?.albumUserRating);
    if (r !== undefined && r > 0 && r <= c.minAlbum) return false;
  }
  if (c.minArtist > 0) {
    const r = numRating(extra?.artistUserRating);
    if (r !== undefined && r > 0 && r <= c.minArtist) return false;
  }
  return true;
}

/**
 * Fetches missing entity ratings (bounded concurrency) then filters. Used for random album grids / hero.
 */
export async function filterAlbumsByMixRatings(
  albums: SubsonicAlbum[],
  c: MixMinRatingsConfig,
): Promise<SubsonicAlbum[]> {
  if (!c.enabled) return albums;
  if (c.minAlbum <= 0 && c.minArtist <= 0) return albums;
  const needArtist = c.minArtist > 0;
  const needAlbum = c.minAlbum > 0;
  let byArtist = new Map<string, number>();
  let byAlbum = new Map<string, number>();
  if (needArtist) {
    const ids = [...new Set(albums.map(a => a.artistId).filter(Boolean))] as string[];
    byArtist = await prefetchArtistUserRatings(ids);
  }
  if (needAlbum) {
    const ids = [...new Set(albums.filter(a => a.userRating === undefined).map(a => a.id))];
    if (ids.length) byAlbum = await prefetchAlbumUserRatings(ids);
  }
  return albums.filter(a =>
    passesMixMinRatingsForAlbum(a, c, {
      artistUserRating: a.artistId ? byArtist.get(a.artistId) : undefined,
      albumUserRating: byAlbum.get(a.id),
    }),
  );
}

/** Enrich when needed, then drop songs excluded by Settings → Ratings → filter-by-rating. */
export async function filterSongsForLuckyMixRatings(
  songs: SubsonicSong[],
  c: MixMinRatingsConfig,
): Promise<SubsonicSong[]> {
  if (!c.enabled) return songs;
  const enriched = await enrichSongsForMixRatingFilter(songs, c);
  return enriched.filter(s => passesMixMinRatings(s, c));
}

/**
 * Merge `getArtist` / `getAlbum` ratings into songs when list payloads omit them,
 * so `passesMixMinRatings` / Lucky Mix filtering see album and artist stars.
 */
/** Drop low-rated seed artists before Lucky Mix picks from listening history. */
export async function filterTopArtistsForMixRatings<T extends { id: string }>(
  artists: T[],
  c: MixMinRatingsConfig,
): Promise<T[]> {
  if (!c.enabled || c.minArtist <= 0 || !artists.length) return artists;
  const byArtist = await prefetchArtistUserRatings(artists.map(a => a.id));
  return artists.filter(a => {
    const r = mixRatingOverrideForEntity(a.id) ?? byArtist.get(a.id);
    if (r === undefined || r <= 0) return true;
    return r > c.minArtist;
  });
}

export async function enrichSongsForMixRatingFilter(
  songs: SubsonicSong[],
  c: MixMinRatingsConfig,
): Promise<SubsonicSong[]> {
  if (!c.enabled || (c.minArtist <= 0 && c.minAlbum <= 0)) return songs;
  const artistIds =
    c.minArtist > 0
      ? [...new Set(songs.map(s => artistEntityIdForMixRating(s)).filter((id): id is string => !!id))]
      : [];
  const albumIds =
    c.minAlbum > 0
      ? [...new Set(songs.filter(s => s.albumId).map(s => s.albumId!))]
      : [];
  const [byArtist, byAlbum] = await Promise.all([
    artistIds.length ? prefetchArtistUserRatings(artistIds) : Promise.resolve(new Map<string, number>()),
    albumIds.length ? prefetchAlbumUserRatings(albumIds) : Promise.resolve(new Map<string, number>()),
  ]);
  if (!byArtist.size && !byAlbum.size) return songs;
  return songs.map(s => {
    const aid = artistEntityIdForMixRating(s);
    const artistPatch =
      aid && byArtist.has(aid) ? { artistUserRating: byArtist.get(aid)! } : {};
    const albumPatch =
      s.albumId && byAlbum.has(s.albumId) ? { albumUserRating: byAlbum.get(s.albumId)! } : {};
    return { ...s, ...artistPatch, ...albumPatch };
  });
}

/**
 * Loads random songs in batches until `targetSize` (or `RANDOM_MIX_TARGET_SIZE`) songs
 * pass `passesMixMinRatings` (after enrich), or batch/duplicate limits are hit.
 *
 * When NO filter is active (neither `enabled` nor `onlyRatedMinStars`), a single
 * batch fast-path is used and capped to a single batch — for `targetSize` greater
 * than `RANDOM_MIX_BATCH_SIZE` (50) the loop path is taken so we can issue multiple
 * `getRandomSongs` calls.
 */
export async function fetchRandomMixSongsUntilFull(
  c: MixMinRatingsConfig,
  opts?: { genre?: string; timeout?: number; targetSize?: number },
): Promise<SubsonicSong[]> {
  const timeout = opts?.timeout ?? 15000;
  const genre = opts?.genre;
  const targetSize = opts?.targetSize ?? RANDOM_MIX_TARGET_SIZE;
  const filterActive = c.enabled;
  const batchSize = batchSizeFor(targetSize, filterActive);

  // Fast-path: no filter — one call asking for the full target, slice, done. The server-side
  // `ORDER BY random() LIMIT N` returns N distinct rows, so a single round-trip usually fills
  // the request without dup-streak gymnastics.
  if (!filterActive) {
    const raw = await getRandomSongs(batchSize, genre, timeout);
    if (raw.length >= targetSize) return raw.slice(0, targetSize);
    // Library smaller than target, or random endpoint returned fewer — fall through to the
    // batched loop below so we can top up via additional calls (deduped by id).
  }

  const maxBatches = maxBatchesFor(targetSize, batchSize, filterActive);
  const maxDupStreak = dupStreakBudget(targetSize);

  const out: SubsonicSong[] = [];
  const outIds = new Set<string>();
  const seenFromApi = new Set<string>();
  let dupStreak = 0;

  for (let b = 0; b < maxBatches && out.length < targetSize; b++) {
    const raw = await getRandomSongs(batchSize, genre, timeout);
    if (!raw.length) break;

    const novel = raw.filter(s => !seenFromApi.has(s.id));
    for (const s of raw) seenFromApi.add(s.id);

    if (!novel.length) {
      if (++dupStreak >= maxDupStreak) break;
      continue;
    }
    dupStreak = 0;

    const enriched = filterActive
      ? await enrichSongsForMixRatingFilter(novel, c)
      : novel;
    for (const s of enriched) {
      if (!passesMixMinRatings(s, c) || outIds.has(s.id)) continue;
      outIds.add(s.id);
      out.push(s);
      if (out.length >= targetSize) break;
    }
  }

  return out;
}
