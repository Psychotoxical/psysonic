import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { CoverArtImage, type CoverArtImageProps } from './CoverArtImage';
import { useTrackCoverRef } from './useLibraryCoverRef';
import { COVER_SCOPE_ACTIVE, type CoverServerScope } from './types';

export type TrackCoverArtImageProps = Omit<CoverArtImageProps, 'coverRef'> & {
  song: Pick<
    SubsonicSong,
    | 'id'
    | 'albumId'
    | 'coverArt'
    | 'discNumber'
    | 'album'
    | 'artist'
    | 'albumArtist'
    | 'displayAlbumArtist'
  >;
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
  // External album-art context (§5): derive artist/album from the song so the
  // server-miss fallback can try apple/lastfm for album refs. An explicit caller
  // `ensureOpts` wins over the derived one.
  const derivedOpts = {
    artistName: song.displayAlbumArtist ?? song.albumArtist ?? song.artist,
    albumTitle: song.album,
  };
  return <CoverArtImage coverRef={coverRef} {...rest} ensureOpts={rest.ensureOpts ?? derivedOpts} />;
}
