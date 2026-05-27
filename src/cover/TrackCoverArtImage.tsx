import type { SubsonicSong } from '../api/subsonicTypes';
import { CoverArtImage, type CoverArtImageProps } from './CoverArtImage';
import { useTrackCoverRef } from './useLibraryCoverRef';
import type { CoverServerScope } from './types';

export type TrackCoverArtImageProps = Omit<CoverArtImageProps, 'coverRef'> & {
  song: Pick<SubsonicSong, 'id' | 'albumId' | 'coverArt' | 'discNumber'>;
  serverScope?: CoverServerScope;
};

export function TrackCoverArtImage({ song, serverScope, ...rest }: TrackCoverArtImageProps) {
  const coverRef = useTrackCoverRef(song, serverScope);
  if (!coverRef) return null;
  return <CoverArtImage coverRef={coverRef} {...rest} />;
}
