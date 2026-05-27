import { CoverArtImage, type CoverArtImageProps } from './CoverArtImage';
import { useArtistCoverRef } from './useLibraryCoverRef';
import { COVER_SCOPE_ACTIVE, type CoverServerScope } from './types';

export type ArtistCoverArtImageProps = Omit<CoverArtImageProps, 'coverRef'> & {
  artistId: string;
  coverArt?: string | null;
  serverScope?: CoverServerScope;
  libraryResolve?: boolean;
};

export function ArtistCoverArtImage({
  artistId,
  coverArt,
  serverScope,
  libraryResolve = false,
  ...rest
}: ArtistCoverArtImageProps) {
  const coverRef = useArtistCoverRef(
    artistId,
    coverArt,
    serverScope ?? COVER_SCOPE_ACTIVE,
    { libraryResolve },
  );
  if (!coverRef) return null;
  return <CoverArtImage coverRef={coverRef} {...rest} />;
}
