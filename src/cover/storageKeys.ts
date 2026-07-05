import { getPlaybackServerId } from '@/features/playback/utils/playback/playbackServer';
import { useAuthStore } from '../store/authStore';
import { findServerByIdOrIndexKey } from '@/lib/server/serverLookup';
import {
  resolveIndexKey,
  serverIndexKeyForProfile,
  serverIndexKeyFromUrl,
} from '@/lib/server/serverIndexKey';
import type { CoverArtRef, CoverArtTier, CoverServerScope } from './types';

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
    const server = sid ? findServerByIdOrIndexKey(sid) : undefined;
    if (server) return serverIndexKeyForProfile(server);
    if (sid) return resolveIndexKey(sid) || sid;
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
  ref: Pick<CoverArtRef, 'cacheKind' | 'cacheEntityId'>,
  tier: CoverArtTier,
): string {
  return `${coverIndexKeyFromScope(serverScope)}:cover:${ref.cacheKind}:${ref.cacheEntityId}:${tier}`;
}

export function coverStorageKeyFromRef(ref: CoverArtRef, tier: CoverArtTier): string {
  return coverStorageKey(ref.serverScope, ref, tier);
}
