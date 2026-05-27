import { CoverArtImage, type CoverArtImageProps } from './CoverArtImage';
import { useAlbumCoverRef } from './useLibraryCoverRef';
import { COVER_SCOPE_ACTIVE, type CoverServerScope } from './types';

export type AlbumCoverArtImageProps = Omit<CoverArtImageProps, 'coverRef'> & {
  albumId: string;
  coverArt?: string | null;
  serverScope?: CoverServerScope;
};

export function AlbumCoverArtImage({
  albumId,
  coverArt,
  serverScope,
  ...rest
}: AlbumCoverArtImageProps) {
  const coverRef = useAlbumCoverRef(albumId, coverArt, serverScope ?? COVER_SCOPE_ACTIVE);
  if (!coverRef) return null;
  return <CoverArtImage coverRef={coverRef} {...rest} />;
}
