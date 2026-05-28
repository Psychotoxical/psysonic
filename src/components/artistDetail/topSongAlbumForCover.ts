import type { SubsonicAlbum, SubsonicSong } from '../../api/subsonicTypes';

export type TopSongAlbumCoverSource = Pick<SubsonicAlbum, 'id' | 'coverArt' | 'name'>;

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

/** Deduped album rows for top-track cover warm (matches album grid warm inputs). */
export function topSongAlbumsForCoverWarm(
  songs: ReadonlyArray<Pick<SubsonicSong, 'albumId' | 'album' | 'coverArt'>>,
  albums: ReadonlyArray<Pick<SubsonicAlbum, 'id' | 'name' | 'coverArt'>>,
): Array<{ id: string; coverArt?: string | null }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; coverArt?: string | null }> = [];
  for (const song of songs) {
    const row = topSongAlbumForCover(song, albums);
    if (!row?.id || seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({ id: row.id, coverArt: row.coverArt });
  }
  return out;
}
