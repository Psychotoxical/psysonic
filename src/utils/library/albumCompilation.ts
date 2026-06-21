import type { LibraryTrackDto } from '../../api/library';
import type { SubsonicAlbum } from '../../api/subsonicTypes';

export type AlbumCompFilter = 'all' | 'only' | 'hide';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Max albums to scan client-side for compilation filter before showing empty. */
export const ALBUM_COMP_FILTER_MAX_SCAN_ALBUMS = 500;

const VARIOUS_ARTISTS = /\bvarious artists\b/i;

/** OpenSubsonic / Navidrome: `compilation`, `isCompilation`, `releaseTypes`, or VA artist. */
export function albumIsCompilation(a: SubsonicAlbum): boolean {
  if (a.isCompilation === true) return true;
  const loose = a as SubsonicAlbum & { compilation?: boolean; albumArtist?: string };
  if (loose.compilation === true) return true;
  if (a.releaseTypes?.some(t => /^compilation$/i.test(t.trim()))) return true;
  const artist = (a.artist ?? '').trim();
  const displayArtist = (a.displayArtist ?? '').trim();
  const albumArtist = (loose.albumArtist ?? '').trim();
  return VARIOUS_ARTISTS.test(artist)
    || VARIOUS_ARTISTS.test(displayArtist)
    || VARIOUS_ARTISTS.test(albumArtist);
}

/** Any track in a grouped album matches compilation signals (offline / local aggregate). */
export function albumIsCompilationFromTrackDtos(tracks: LibraryTrackDto[]): boolean {
  for (const t of tracks) {
    const raw = isObject(t.rawJson) ? t.rawJson : {};
    const loose = raw as Partial<SubsonicAlbum> & { compilation?: boolean; albumArtist?: string };
    const probe: SubsonicAlbum = {
      id: t.albumId ?? '',
      name: t.album ?? '',
      artist: t.albumArtist ?? t.artist ?? '',
      artistId: t.artistId ?? '',
      songCount: 0,
      duration: 0,
      ...loose,
      displayArtist: typeof loose.displayArtist === 'string' ? loose.displayArtist : undefined,
    };
    if (albumIsCompilation(probe)) return true;
  }
  return false;
}

/** Network page mode: compilation filter runs client-side on each getAlbumList2 page. */
export function albumBrowseCompFilterClientOnly(
  compFilter: AlbumCompFilter,
  browseMode: 'slice' | 'page',
): boolean {
  return compFilter !== 'all' && browseMode === 'page';
}

/** Stop paginating when the catalog tail is reached or the scan budget is spent. */
export function albumBrowseCompScanComplete(
  loadedAlbums: SubsonicAlbum[],
  compFilter: AlbumCompFilter,
  hasMore: boolean,
): boolean {
  if (compFilter === 'all') return true;
  if (!hasMore) return true;
  if (loadedAlbums.length >= ALBUM_COMP_FILTER_MAX_SCAN_ALBUMS) return true;
  return false;
}
