import type { SubsonicSong } from '../api/subsonicTypes';
import { CoverArtImage, type CoverArtImageProps } from './CoverArtImage';
import { useTrackCoverRef } from './useLibraryCoverRef';
import { COVER_SCOPE_ACTIVE, type CoverServerScope } from './types';

export type TrackCoverArtImageProps = Omit<CoverArtImageProps, 'coverRef'> & {
  song: Pick<SubsonicSong, 'id' | 'albumId' | 'coverArt' | 'discNumber'>;
  serverScope?: CoverServerScope;
};

export function TrackCoverArtImage({ song, serverScope, ...rest }: TrackCoverArtImageProps) {
  const coverRef = useTrackCoverRef(song, serverScope ?? COVER_SCOPE_ACTIVE);
  if (!coverRef) return null;
  return <CoverArtImage coverRef={coverRef} {...rest} />;
}
