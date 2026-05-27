import { CoverArtImage, type CoverArtImageProps } from './CoverArtImage';
import { useAlbumCoverRef } from './useLibraryCoverRef';
import type { CoverServerScope } from './types';

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
  const coverRef = useAlbumCoverRef(albumId, coverArt, serverScope);
  if (!coverRef) return null;
  return <CoverArtImage coverRef={coverRef} {...rest} />;
}
