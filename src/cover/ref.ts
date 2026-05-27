import { getPlaybackServerId } from '../utils/playback/playbackServer';
import { useAuthStore } from '../store/authStore';
import { findServerByIdOrIndexKey } from '../utils/server/serverLookup';
import type { CoverArtId, CoverArtRef, CoverServerScope } from './types';

export function coverArtRef(
  coverArtId: CoverArtId,
  serverScope: CoverServerScope = { kind: 'active' },
): CoverArtRef {
  return { coverArtId, serverScope };
}

export function resolvePlaybackCoverScope(): CoverServerScope {
  const playbackSid = getPlaybackServerId();
  const activeSid = useAuthStore.getState().activeServerId;
  if (playbackSid && activeSid && playbackSid !== activeSid) {
    const server = findServerByIdOrIndexKey(playbackSid);
    if (server) {
      return {
        kind: 'server',
        serverId: server.id,
        url: server.url,
        username: server.username,
        password: server.password,
      };
    }
  }
  return { kind: 'playback' };
}
