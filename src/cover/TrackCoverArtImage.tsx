import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { CoverArtImage, type CoverArtImageProps } from './CoverArtImage';
import { useTrackCoverRef } from './useLibraryCoverRef';
import { COVER_SCOPE_ACTIVE, type CoverServerScope } from './types';

export type TrackCoverArtImageProps = Omit<CoverArtImageProps, 'coverRef'> & {
  song: Pick<SubsonicSong, 'id' | 'albumId' | 'coverArt' | 'discNumber'>;
  serverScope?: CoverServerScope;
  /** Default false for browse rails; true for queue/player rows needing per-disc art. */
  libraryResolve?: boolean;
};

export function TrackCoverArtImage({
  song,
  serverScope,
  libraryResolve = false,
  ...rest
}: TrackCoverArtImageProps) {
  const coverRef = useTrackCoverRef(song, serverScope ?? COVER_SCOPE_ACTIVE, { libraryResolve });
  if (!coverRef) return null;
  return <CoverArtImage coverRef={coverRef} {...rest} />;
}
