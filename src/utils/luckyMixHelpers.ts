import { getTopSongs } from '../api/subsonicArtists';
import { filterSongsToActiveLibrary, getAlbum, getAlbumList, getRandomSongs } from '../api/subsonicLibrary';
import type { SubsonicAlbum, SubsonicSong } from '../api/subsonicTypes';
import {
  filterSongsForLuckyMixRatings,
  type MixMinRatingsConfig,
} from './mixRatingFilter';

export interface TopArtist {
  id: string;
  name: string;
  totalPlays: number;
}

export const MOST_PLAYED_PAGE_SIZE = 100;
export const MOST_PLAYED_MAX_ALBUMS = 500;
export const MIX_TARGET_SIZE = 50;
export const SEED_TARGET_SIZE = 15;

export function sampleRandom<T>(items: T[], count: number): T[] {
  if (count <= 0 || items.length === 0) return [];
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(count, arr.length));
}

export function uniqueBySongId(items: SubsonicSong[]): SubsonicSong[] {
  const out: SubsonicSong[] = [];
  const seen = new Set<string>();
  for (const s of items) {
    if (!s?.id || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

export function uniqueAppend(base: SubsonicSong[], incoming: SubsonicSong[]): SubsonicSong[] {
  return uniqueBySongId([...base, ...incoming]);
}

export function deriveTopArtistsFromFrequentAlbums(albums: SubsonicAlbum[]): TopArtist[] {
  const map = new Map<string, TopArtist>();
  for (const a of albums) {
    const plays = a.playCount ?? 0;
    if (!a.artistId || !a.artist || plays <= 0) continue;
    const prev = map.get(a.artistId);
    if (prev) {
      prev.totalPlays += plays;
      continue;
    }
    map.set(a.artistId, { id: a.artistId, name: a.artist, totalPlays: plays });
  }
  return [...map.values()].sort((a, b) => b.totalPlays - a.totalPlays);
}

export async function fetchFrequentAlbumsPool(): Promise<SubsonicAlbum[]> {
  const out: SubsonicAlbum[] = [];
  let offset = 0;
  while (out.length < MOST_PLAYED_MAX_ALBUMS) {
    const page = await getAlbumList('frequent', MOST_PLAYED_PAGE_SIZE, offset);
    if (!page.length) break;
    out.push(...page);
    if (page.length < MOST_PLAYED_PAGE_SIZE) break;
    offset += MOST_PLAYED_PAGE_SIZE;
  }
  return out;
}

export async function pickSongsForArtist(
  artist: TopArtist,
  need: number,
  mixRatings: MixMinRatingsConfig,
): Promise<SubsonicSong[]> {
  const primary = uniqueBySongId(await filterSongsToActiveLibrary(await getTopSongs(artist.name)));
  let pool = primary;
  if (primary.length < need) {
    const extra: SubsonicSong[] = [];
    for (let i = 0; i < 8 && primary.length + extra.length < need * 4; i++) {
      const rnd = await filterSongsToActiveLibrary(await getRandomSongs(120));
      for (const s of rnd) {
        if (s.artistId === artist.id || s.artist === artist.name) {
          extra.push(s);
        }
      }
    }
    pool = uniqueBySongId([...primary, ...extra]);
  }
  const filtered = await filterSongsForLuckyMixRatings(pool, mixRatings);
  return sampleRandom(filtered, Math.min(need, filtered.length));
}

export async function pickSongsForAlbum(
  albumId: string,
  need: number,
  mixRatings: MixMinRatingsConfig,
): Promise<SubsonicSong[]> {
  const full = await getAlbum(albumId).catch(() => null);
  if (!full?.songs?.length) return [];
  const scopedSongs = await filterSongsToActiveLibrary(full.songs);
  const unique = uniqueBySongId(scopedSongs);
  const filtered = await filterSongsForLuckyMixRatings(unique, mixRatings);
  return sampleRandom(filtered, Math.min(need, filtered.length));
}

export async function pickGoodRatedSongs(
  existingIds: Set<string>,
  need: number,
  mixRatings: MixMinRatingsConfig,
): Promise<SubsonicSong[]> {
  const out: SubsonicSong[] = [];
  const push = (s: SubsonicSong) => {
    const r = s.userRating ?? 0;
    if (r < 4) return;
    if (existingIds.has(s.id)) return;
    if (out.some(x => x.id === s.id)) return;
    out.push(s);
  };

  for (let i = 0; i < 14 && out.length < need * 8; i++) {
    const rnd = await filterSongsToActiveLibrary(await getRandomSongs(120));
    rnd.forEach(push);
  }

  const filtered = await filterSongsForLuckyMixRatings(out, mixRatings);
  return sampleRandom(filtered, Math.min(need, filtered.length));
}
