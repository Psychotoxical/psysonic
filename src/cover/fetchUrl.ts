import {
  buildCoverArtUrl,
  buildCoverArtUrlForServer,
} from '@/lib/api/subsonicStreamUrl';
import { getPlaybackServerId } from '@/features/playback/utils/playback/playbackServer';
import { useAuthStore } from '../store/authStore';
import { connectBaseUrlForServer } from '@/lib/server/serverEndpoint';
import type { CoverArtRef, CoverArtTier } from './types';

/** Builds ephemeral getCoverArt URL — NOT a cache key */
export function buildCoverArtFetchUrl(ref: CoverArtRef, tier: CoverArtTier): string {
  const { fetchCoverArtId, serverScope } = ref;
  if (serverScope.kind === 'server') {
    // Scope.url is the index-stable primary URL (so storage keys keep working
    // across LAN ↔ public). For the actual cover fetch we want the connect
    // endpoint — use connectBaseUrlForServer to pick the cached LAN/public
    // URL, falling back to the primary url when no probe has run yet.
    return buildCoverArtUrlForServer(
      connectBaseUrlForServer({ id: serverScope.serverId, url: serverScope.url }),
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
          connectBaseUrlForServer(server),
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
