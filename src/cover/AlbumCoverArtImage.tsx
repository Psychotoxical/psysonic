import { CoverArtImage, type CoverArtImageProps } from './CoverArtImage';
import { useAlbumCoverRef } from './useLibraryCoverRef';
import { COVER_SCOPE_ACTIVE, type CoverServerScope } from './types';

export type AlbumCoverArtImageProps = Omit<CoverArtImageProps, 'coverRef'> & {
  albumId: string;
  coverArt?: string | null;
  serverScope?: CoverServerScope;
  /** Live search: use API `coverArt` ids only (avoids library IPC per row). */
  libraryResolve?: boolean;
};

export function AlbumCoverArtImage({
  albumId,
  coverArt,
  serverScope,
  libraryResolve = false,
  ...rest
}: AlbumCoverArtImageProps) {
  const coverRef = useAlbumCoverRef(
    albumId,
    coverArt,
    serverScope ?? COVER_SCOPE_ACTIVE,
    { libraryResolve },
  );
  if (!coverRef) return null;
  return <CoverArtImage coverRef={coverRef} {...rest} />;
}
