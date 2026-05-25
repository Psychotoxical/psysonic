import {
  buildCoverArtUrl,
  buildCoverArtUrlForServer,
} from '../api/subsonicStreamUrl';
import { useAuthStore } from '../store/authStore';
import type { CoverArtRef, CoverArtTier } from './types';

/** Builds ephemeral getCoverArt URL — NOT a cache key */
export function buildCoverArtFetchUrl(ref: CoverArtRef, tier: CoverArtTier): string {
  const scope = ref.serverScope;
  if (scope.kind === 'server') {
    return buildCoverArtUrlForServer(scope.url, scope.username, scope.password, ref.coverArtId, tier);
  }
  const { getActiveServer } = useAuthStore.getState();
  if (scope.kind === 'playback') {
    // playback scope resolved by caller via queue server — fall through to active for URL
  }
  return buildCoverArtUrl(ref.coverArtId, tier);
}
