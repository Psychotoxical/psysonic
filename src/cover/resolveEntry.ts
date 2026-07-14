/**
 * Single source of truth for cover cache keys and HTTP fetch ids.
 *
 * Entities: **artist**, **album**, **track-on-album** (track art is always album-scoped
 * unless the album has distinct per-CD covers).
 *
 * Disk path shape is Rust-only (`psysonic_core::cover_cache_layout`); this module must
 * stay in sync with `resolve_album_cover` / `resolve_artist_cover` there.
 */

import type { SubsonicAlbum, SubsonicSong } from '@/lib/api/subsonicTypes';
import type { CoverArtRef, CoverCacheKind, CoverServerScope } from './types';

/** Resolved cover identity — maps 1:1 to Rust `CoverEntry`. */
export type CoverEntry = {
  cacheKind: CoverCacheKind;
  cacheEntityId: string;
  fetchCoverArtId: string;
};

export type CoverArtResolvableSong = Pick<SubsonicSong, 'id' | 'coverArt'> & {
  albumId?: string | null;
};

/**
 * True for ids that are only valid as `getCoverArt` targets, not library entity keys.
 * Keep in sync with Rust `psysonic_core::cover_cache_layout::is_fetch_only_cover_id`.
 */
export function isFetchOnlyCoverId(id: string): boolean {
  const trimmed = id.trim();
  return (
    trimmed.startsWith('mf-')
    || trimmed.startsWith('tr-')
    || trimmed.startsWith('pl-')
    || trimmed.startsWith('dc-')
    || trimmed.startsWith('ra-')
  );
}

/** Navidrome `getCoverArt` id for a song row (ignores echo of track id with no art). */
export function resolveSongFetchCoverArtId(song: CoverArtResolvableSong): string | undefined {
  const albumId = song.albumId?.trim();
  const cover = song.coverArt?.trim();
  const songId = song.id?.trim();
  if (cover && (!songId || cover !== songId)) return cover;
  if (albumId) return albumId;
  if (cover) return cover;
  return undefined;
}

/**
 * True only for genuine per-disc artwork: a multi-disc release where each disc
 * has ONE consistent cover and those covers differ between discs (e.g. a box
 * set). It must NOT be tripped by per-song cover ids — Navidrome (and other
 * OpenSubsonic servers) give every track its own `mf-<id>` coverArt, so a disc
 * whose tracks carry many different ids is per-song art, not per-disc art, and
 * treating it as distinct would warm one cover per track instead of per album.
 *
 * Mirrors `album_has_distinct_disc_covers` in `psysonic-library/cover_resolve.rs`.
 */
export function albumHasDistinctDiscCovers(
  songs: ReadonlyArray<Pick<SubsonicSong, 'discNumber' | 'coverArt' | 'id' | 'albumId'>>,
): boolean {
  const artByDisc = new Map<number, Set<string>>();
  for (const song of songs) {
    const disc = song.discNumber ?? 1;
    const artId = resolveSongFetchCoverArtId(song);
    if (!artId) continue;
    let set = artByDisc.get(disc);
    if (!set) {
      set = new Set<string>();
      artByDisc.set(disc, set);
    }
    set.add(artId);
  }
  if (artByDisc.size <= 1) return false;
  const discCovers = new Set<string>();
  for (const covers of artByDisc.values()) {
    // Tracks within a disc disagree → per-song ids, not a shared disc cover.
    if (covers.size !== 1) return false;
    for (const cover of covers) discCovers.add(cover);
  }
  return discCovers.size > 1;
}

/** Re-apply album fetch rules to a library-resolved entry (SQLite may still carry per-track `mf-*`). */
export function normalizeAlbumLibraryEntry(albumId: string, entry: CoverEntry): CoverEntry {
  const album = albumId.trim();
  const distinctDiscCovers = entry.cacheEntityId.trim() !== album;
  return resolveAlbumCoverEntry(album, entry.fetchCoverArtId, distinctDiscCovers)!;
}

/** Album entity — one cache slot per album unless `distinctDiscCovers`. */
export function resolveAlbumCoverEntry(
  albumId: string,
  coverArtId?: string | null,
  distinctDiscCovers = false,
): CoverEntry | undefined {
  const album = albumId.trim();
  if (!album) return undefined;
  let fetch = coverArtId?.trim() || album;
  // Navidrome track-only libraries (no `album` row): each track carries its own
  // `mf-*` id but getCoverArt still serves album artwork. Keep one consensus mf
  // fetch per album (library backfill picks the first track) while the disk slot
  // stays album-scoped — never one cache dir per track in browse lists.
  if (!distinctDiscCovers && fetch.startsWith('mf-') && fetch !== album) {
    return { cacheKind: 'album', cacheEntityId: album, fetchCoverArtId: fetch };
  }
  // Bare album ids need `al-<albumId>_0` on Navidrome when no mf id is available.
  // Playlist / radio / other fetch-only ids must keep their native prefix (e.g. `pl-*`).
  if (!distinctDiscCovers && fetch === album && !isFetchOnlyCoverId(fetch)) {
    fetch = `al-${album}_0`;
  }
  const cacheEntityId =
    distinctDiscCovers && fetch !== album ? fetch : album;
  return { cacheKind: 'album', cacheEntityId, fetchCoverArtId: fetch };
}

/** Artist entity — one cache slot per artist. */
export function resolveArtistCoverEntry(
  artistId: string,
  coverArtId?: string | null,
): CoverEntry | undefined {
  const artist = artistId.trim();
  if (!artist) return undefined;
  const fetch = coverArtId?.trim() || artist;
  return { cacheKind: 'artist', cacheEntityId: artist, fetchCoverArtId: fetch };
}

/** Track on an album — album cache by default; per-disc fetch id when `distinctDiscCovers`. */
export function resolveTrackCoverEntry(
  song: Pick<SubsonicSong, 'albumId' | 'coverArt' | 'id' | 'discNumber'>,
  distinctDiscCovers = false,
): CoverEntry | undefined {
  const albumId = song.albumId?.trim();
  if (!albumId) return undefined;
  const fetch = resolveSongFetchCoverArtId(song) ?? albumId;
  return resolveAlbumCoverEntry(albumId, fetch, distinctDiscCovers);
}

export function coverEntryToRef(
  entry: CoverEntry,
  serverScope: CoverServerScope = { kind: 'active' },
): CoverArtRef {
  return {
    cacheKind: entry.cacheKind,
    cacheEntityId: entry.cacheEntityId,
    fetchCoverArtId: entry.fetchCoverArtId,
    serverScope,
  };
}

/** @deprecated Alias for {@link resolveSongFetchCoverArtId}. */
export const resolveSubsonicSongCoverArtId = resolveSongFetchCoverArtId;

/** @deprecated Top tracks use album row `id` + `coverArt` like AlbumCard. */
export function resolveArtistPageSongFetchCoverArtId(
  song: Pick<SubsonicSong, 'id' | 'coverArt' | 'albumId' | 'album' | 'discNumber'>,
  albums: ReadonlyArray<Pick<SubsonicAlbum, 'id' | 'name' | 'coverArt'>>,
): string | undefined {
  const songArt = resolveSongFetchCoverArtId(song);
  const album = song.albumId
    ? albums.find(a => a.id === song.albumId)
    : albums.find(a => a.name === song.album);
  const albumCover = album?.coverArt?.trim();
  const songId = song.id?.trim();

  const songRowArt = song.coverArt?.trim();
  const perDiscArt =
    Boolean(songArt && albumCover && songArt !== albumCover)
    && Boolean(
      (songRowArt && songRowArt !== songId)
      || (songArt?.startsWith('mf-') ?? false),
    );

  if (perDiscArt && songArt) return songArt;

  if (albumCover && (!songId || albumCover !== songId)) return albumCover;
  return songArt;
}
