import {
  buildCoverArtUrl,
  buildCoverArtUrlForServer,
} from '../api/subsonicStreamUrl';
import { getPlaybackServerId } from '../utils/playback/playbackServer';
import { useAuthStore } from '../store/authStore';
import type { CoverArtRef, CoverArtTier } from './types';

/** Builds ephemeral getCoverArt URL — NOT a cache key */
export function buildCoverArtFetchUrl(ref: CoverArtRef, tier: CoverArtTier): string {
  const { coverArtId, serverScope } = ref;
  if (serverScope.kind === 'server') {
    return buildCoverArtUrlForServer(
      serverScope.url,
      serverScope.username,
      serverScope.password,
      coverArtId,
      tier,
    );
  }
  if (serverScope.kind === 'playback') {
    const playbackSid = getPlaybackServerId();
    const activeSid = useAuthStore.getState().activeServerId;
    if (playbackSid && activeSid && playbackSid !== activeSid) {
      const server = useAuthStore.getState().servers.find(s => s.id === playbackSid);
      if (server) {
        return buildCoverArtUrlForServer(
          server.url,
          server.username,
          server.password,
          coverArtId,
          tier,
        );
      }
    }
  }
  return buildCoverArtUrl(coverArtId, tier);
}
