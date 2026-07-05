import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { useLocalPlaybackStore, type LocalPlaybackTier } from '@/store/localPlaybackStore';
import { serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { hasLocalPlaybackUrl } from '@/store/localPlaybackResolve';
import { resolvePlaybackUrl } from '@/features/playback/utils/playback/resolvePlaybackUrl';
import { makeServer } from '@/test/helpers/factories';
import { resetAllStores } from '@/test/helpers/storeReset';

// `hasLocalPlaybackUrl` is behavior-adjacent (c37d5f7): it mirrors
// `resolvePlaybackUrl`'s local-source branch so `subsonicNetworkGuard` can skip the
// reachability probe for local tracks without importing @/features/playback. Its
// only other test mocks it away, so the mirroring itself is what this file locks.

const server = makeServer({ id: 'srv-1', url: 'https://demo.example' });
const INDEX_KEY = serverIndexKeyForProfile(server); // url-derived key ('demo.example')
const TRACK = 't1';

function seedLocal(tier: LocalPlaybackTier): void {
  useLocalPlaybackStore.getState().upsertEntry({
    serverIndexKey: INDEX_KEY,
    trackId: TRACK,
    localPath: `/disk/${TRACK}.opus`,
    layoutFingerprint: 'fp',
    sizeBytes: 1,
    suffix: 'opus',
    tier,
  });
}

beforeEach(() => {
  resetAllStores();
  useAuthStore.setState({ servers: [server], activeServerId: server.id });
  useLocalPlaybackStore.setState({ entries: {} });
});

describe('hasLocalPlaybackUrl', () => {
  it.each<LocalPlaybackTier>(['library', 'favorite-auto', 'ephemeral'])(
    'is true when a local URL exists in the %s tier',
    (tier) => {
      seedLocal(tier);
      expect(hasLocalPlaybackUrl(TRACK, server.id)).toBe(true);
    },
  );

  it('is false when the track has no local bytes', () => {
    expect(hasLocalPlaybackUrl(TRACK, server.id)).toBe(false);
    seedLocal('library');
    expect(hasLocalPlaybackUrl('other-track', server.id)).toBe(false);
  });

  it('resolves an index-key serverId the same as the raw profile id', () => {
    seedLocal('library');
    // Passing the url-derived index key must resolve to the same profile via
    // resolveServerIdForIndexKey → identical result to passing the raw id.
    expect(hasLocalPlaybackUrl(TRACK, INDEX_KEY)).toBe(true);
    expect(hasLocalPlaybackUrl(TRACK, INDEX_KEY)).toBe(hasLocalPlaybackUrl(TRACK, server.id));
    expect(hasLocalPlaybackUrl('other-track', INDEX_KEY)).toBe(false);
  });

  it.each<LocalPlaybackTier | 'none'>(['library', 'favorite-auto', 'ephemeral', 'none'])(
    'agrees with resolvePlaybackUrl local branch (%s)',
    (tier) => {
      if (tier !== 'none') seedLocal(tier);
      const local = hasLocalPlaybackUrl(TRACK, server.id);
      const viaResolve = resolvePlaybackUrl(TRACK, server.id).startsWith('psysonic-local://');
      expect(local).toBe(viaResolve);
    },
  );
});
