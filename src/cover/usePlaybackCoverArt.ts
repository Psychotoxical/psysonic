import { useMemo } from 'react';
import { resolvePlaybackCoverScope } from './ref';
import type { CoverArtHandle, CoverArtRef } from './types';
import { useCoverArt } from './useCoverArt';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';

/** Cover art for playback queue — uses queue server when it differs from browsed server. */
export function usePlaybackCoverArt(
  coverRef: CoverArtRef | undefined,
  displayCssPx: number,
  opts?: { fullRes?: boolean },
): CoverArtHandle {
  const queueServerId = usePlayerStore(s => s.queueServerId);
  const queueIndex = usePlayerStore(s => s.queueIndex);
  const playingServerId = usePlayerStore(
    s => s.queueItems[s.queueIndex]?.serverId ?? '',
  );
  const queueLength = usePlayerStore(s => s.queueItems.length);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const serversFingerprint = useAuthStore(s =>
    s.servers
      .map(srv => `${srv.id}\u0001${srv.url}\u0001${srv.username}\u0001${srv.password}`)
      .join('\u0002'),
  );

  const scope = useMemo(
    () => resolvePlaybackCoverScope(),
    [queueServerId, queueIndex, playingServerId, queueLength, activeServerId, serversFingerprint],
  );
  const refWithScope = useMemo(
    () => (coverRef ? { ...coverRef, serverScope: scope } : null),
    [coverRef, scope],
  );
  return useCoverArt(refWithScope, displayCssPx, {
    surface: 'sparse',
    fullRes: opts?.fullRes,
  });
}
