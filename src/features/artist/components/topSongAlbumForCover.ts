import type { SubsonicAlbum, SubsonicSong } from '@/lib/api/subsonicTypes';

export type TopSongAlbumCoverSource = Pick<SubsonicAlbum, 'id' | 'coverArt' | 'name'>;

export type AlbumCoverWarmRow = { id: string; coverArt?: string | null };

function pushAlbumWarmRow(
  out: AlbumCoverWarmRow[],
  seen: Set<string>,
  row: { id?: string | null; coverArt?: string | null } | null | undefined,
  limit: number,
): void {
  const id = row?.id?.trim();
  if (!id || seen.has(id) || out.length >= limit) return;
  seen.add(id);
  out.push({ id, coverArt: row?.coverArt });
}

/**
 * Album row for cover loading on artist top tracks — same `id` + `coverArt` as
 * {@link AlbumCard} when the album is in the artist discography; otherwise the
 * featured-album fallback shape (`albumId` + song `coverArt`).
 */
export function topSongAlbumForCover(
  song: Pick<SubsonicSong, 'albumId' | 'album' | 'coverArt'>,
  albums: ReadonlyArray<Pick<SubsonicAlbum, 'id' | 'name' | 'coverArt'>>,
): TopSongAlbumCoverSource | null {
  const albumId = song.albumId?.trim();
  if (!albumId) return null;

  const fromList =
    albums.find(a => a.id === albumId)
    ?? albums.find(a => a.name === song.album);
  if (fromList) return fromList;

  return {
    id: albumId,
    name: song.album,
    coverArt: song.coverArt,
  };
}

export function topSongAlbumsForCoverWarm(
  songs: ReadonlyArray<Pick<SubsonicSong, 'albumId' | 'album' | 'coverArt'>>,
  albums: ReadonlyArray<Pick<SubsonicAlbum, 'id' | 'name' | 'coverArt'>>,
): AlbumCoverWarmRow[] {
  const seen = new Set<string>();
  const out: AlbumCoverWarmRow[] = [];
  for (const song of songs) {
    pushAlbumWarmRow(out, seen, topSongAlbumForCover(song, albums), songs.length);
  }
  return out;
}

/**
 * Top-track albums first, then discography — same warm list shape as All Albums grids.
 * Use {@link COVER_DENSE_GRID_MIN_CELL_CSS_PX} for peek/ensure tier (not the 32px thumb size).
 */
export function artistDetailCoverWarmAlbums(
  topSongs: ReadonlyArray<Pick<SubsonicSong, 'albumId' | 'album' | 'coverArt'>>,
  albums: ReadonlyArray<Pick<SubsonicAlbum, 'id' | 'name' | 'coverArt'>>,
  limit: number,
): AlbumCoverWarmRow[] {
  const seen = new Set<string>();
  const out: AlbumCoverWarmRow[] = [];
  for (const song of topSongs) {
    if (out.length >= limit) break;
    pushAlbumWarmRow(out, seen, topSongAlbumForCover(song, albums), limit);
  }
  for (const album of albums) {
    if (out.length >= limit) break;
    pushAlbumWarmRow(out, seen, album, limit);
  }
  return out;
}
