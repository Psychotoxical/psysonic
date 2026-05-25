import { getPlaybackServerId } from '../utils/playback/playbackServer';
import { useAuthStore } from '../store/authStore';
import type { CoverArtId, CoverArtTier, CoverServerScope } from './types';

export function serverIdFromScope(scope: CoverServerScope): string {
  if (scope.kind === 'server') return scope.serverId;
  if (scope.kind === 'playback') {
    const sid = getPlaybackServerId();
    return (sid || useAuthStore.getState().activeServerId) ?? '_';
  }
  return useAuthStore.getState().activeServerId ?? '_';
}

export function coverStorageKey(
  serverScope: CoverServerScope,
  coverArtId: CoverArtId,
  tier: CoverArtTier,
): string {
  return `${serverIdFromScope(serverScope)}:cover:${coverArtId}:${tier}`;
}
