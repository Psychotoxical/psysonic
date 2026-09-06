import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { CoverArtImage, type CoverArtImageProps } from './CoverArtImage';
import { useAlbumCoverRef } from './useLibraryCoverRef';
import { COVER_SCOPE_ACTIVE, type CoverServerScope } from './types';

export type AlbumCoverArtImageProps = Omit<CoverArtImageProps, 'coverRef'> & {
  albumId: string;
  coverArt?: string | null;
  serverScope?: CoverServerScope;
  /** Live search: use API `coverArt` ids only (avoids library IPC per row). */
  libraryResolve?: boolean;
  /** Album object — supplies artist/title so the server-miss fallback can fire. */
  album?: Pick<SubsonicAlbum, 'name' | 'artist' | 'displayArtist'>;
};

export function AlbumCoverArtImage({
  albumId,
  coverArt,
  serverScope,
  libraryResolve = false,
  album,
  ...rest
}: AlbumCoverArtImageProps) {
  const coverRef = useAlbumCoverRef(
    albumId,
    coverArt,
    serverScope ?? COVER_SCOPE_ACTIVE,
    { libraryResolve },
  );
  if (!coverRef) return null;
  // External album-art context (§5): derive artist/title from the album object so
  // the server-miss fallback can try apple/lastfm for album refs. An explicit
  // caller `ensureOpts` wins over the derived one.
  const derivedOpts = album
    ? { artistName: album.displayArtist ?? album.artist, albumTitle: album.name }
    : undefined;
  return <CoverArtImage coverRef={coverRef} {...rest} ensureOpts={rest.ensureOpts ?? derivedOpts} />;
}
