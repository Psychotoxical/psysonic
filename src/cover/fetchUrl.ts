import {
  buildCoverArtUrl,
  buildCoverArtUrlForServer,
} from '../api/subsonicStreamUrl';
import { getPlaybackServerId } from '../utils/playback/playbackServer';
import { useAuthStore } from '../store/authStore';
import type { CoverArtRef, CoverArtTier } from './types';

/** Builds ephemeral getCoverArt URL — NOT a cache key */
export function buildCoverArtFetchUrl(ref: CoverArtRef, tier: CoverArtTier): string {
  const { fetchCoverArtId, serverScope } = ref;
  if (serverScope.kind === 'server') {
    return buildCoverArtUrlForServer(
      serverScope.url,
      serverScope.username,
      serverScope.password,
      fetchCoverArtId,
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
          fetchCoverArtId,
          tier,
        );
      }
    }
  }
  return buildCoverArtUrl(fetchCoverArtId, tier);
}
