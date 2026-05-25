import { getPlaybackServerId } from '../utils/playback/playbackServer';
import { useAuthStore } from '../store/authStore';
import {
  serverIndexKeyForProfile,
  serverIndexKeyFromUrl,
} from '../utils/server/serverIndexKey';
import type { CoverArtId, CoverArtRef, CoverArtTier, CoverServerScope } from './types';

/**
 * Stable server bucket for cover disk + IDB — same host index key as library SQLite (`server_id` column).
 * Not the auth profile UUID; URL aliases (LAN vs public) will map to one key later.
 */
export function coverIndexKeyFromScope(scope: CoverServerScope): string {
  if (scope.kind === 'server') {
    return serverIndexKeyFromUrl(scope.url) || scope.serverId;
  }
  if (scope.kind === 'playback') {
    const playbackSid = getPlaybackServerId();
    const activeSid = useAuthStore.getState().activeServerId;
    const sid = playbackSid || activeSid;
    const server = sid
      ? useAuthStore.getState().servers.find(s => s.id === sid)
      : undefined;
    if (server) return serverIndexKeyForProfile(server);
    return '_';
  }
  const server = useAuthStore.getState().getActiveServer();
  if (server) return serverIndexKeyForProfile(server);
  return '_';
}

export function coverIndexKeyFromRef(ref: CoverArtRef): string {
  return coverIndexKeyFromScope(ref.serverScope);
}

/** @deprecated Use `coverIndexKeyFromScope` */
export const serverIdFromScope = coverIndexKeyFromScope;

export function coverStorageKey(
  serverScope: CoverServerScope,
  coverArtId: CoverArtId,
  tier: CoverArtTier,
): string {
  return `${coverIndexKeyFromScope(serverScope)}:cover:${coverArtId}:${tier}`;
}
