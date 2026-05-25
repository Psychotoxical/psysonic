import { useAuthStore } from '../store/authStore';
import type { CoverArtId, CoverArtTier, CoverServerScope } from './types';

export function serverIdFromScope(scope: CoverServerScope): string {
  if (scope.kind === 'active') return useAuthStore.getState().activeServerId ?? '_';
  if (scope.kind === 'playback') return useAuthStore.getState().activeServerId ?? '_';
  return scope.serverId;
}

export function coverStorageKey(
  serverScope: CoverServerScope,
  coverArtId: CoverArtId,
  tier: CoverArtTier,
): string {
  return `${serverIdFromScope(serverScope)}:cover:${coverArtId}:${tier}`;
}
