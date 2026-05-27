/** @deprecated Import from `./resolveEntry` — kept for gradual migration. */
export type { CoverArtResolvableSong } from './resolveEntry';
export {
  resolveArtistPageSongFetchCoverArtId as resolveArtistPageSongCoverArtId,
  resolveSongFetchCoverArtId as resolveSubsonicSongCoverArtId,
} from './resolveEntry';

import type { CoverArtResolvableSong } from './resolveEntry';
import { resolveSongFetchCoverArtId } from './resolveEntry';

/** @deprecated Use {@link resolveSongFetchCoverArtId}. */
export function resolvePlaybackTrackCoverArtId(
  track: CoverArtResolvableSong | null | undefined,
): string | undefined {
  if (!track) return undefined;
  return resolveSongFetchCoverArtId({
    id: track.id,
    coverArt: track.coverArt,
    albumId: track.albumId ?? '',
  });
}
