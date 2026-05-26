import { useMemo } from 'react';
import { resolvePlaybackCoverScope } from './ref';
import type { CoverArtHandle, CoverArtId } from './types';
import { useCoverArt } from './useCoverArt';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';

/** Cover art for playback queue — uses queue server when it differs from browsed server. */
export function usePlaybackCoverArt(
  coverArtId: CoverArtId | undefined,
  displayCssPx: number,
): CoverArtHandle {
  const queueServerId = usePlayerStore(s => s.queueServerId);
  const queueLength = usePlayerStore(s => s.queue.length);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const serversFingerprint = useAuthStore(s =>
    s.servers
      .map(srv => `${srv.id}\u0001${srv.url}\u0001${srv.username}\u0001${srv.password}`)
      .join('\u0002'),
  );

  const scope = useMemo(
    () => resolvePlaybackCoverScope(),
    [queueServerId, queueLength, activeServerId, serversFingerprint],
  );
  return useCoverArt(coverArtId, displayCssPx, {
    serverScope: scope,
    surface: 'sparse',
  });
}
