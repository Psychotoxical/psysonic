import { useMemo } from 'react';
import { resolvePlaybackCoverScope } from './ref';
import type { CoverArtHandle, CoverArtId } from './types';
import { useCoverArt } from './useCoverArt';

/** Cover art for playback queue — uses queue server when it differs from browsed server. */
export function usePlaybackCoverArt(
  coverArtId: CoverArtId | undefined,
  displayCssPx: number,
): CoverArtHandle {
  const scope = useMemo(() => resolvePlaybackCoverScope(), []);
  return useCoverArt(coverArtId, displayCssPx, {
    serverScope: scope,
    surface: 'sparse',
  });
}
