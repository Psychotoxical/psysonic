import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import {
  activateCanonicalNavidromeOwners,
  canonicalizeNavidromeId,
  deactivateCanonicalNavidromeOwners,
} from '@/lib/server/navidromeCanonicalIds';
import { canonicalizePlaybackTrack, toQueueItemRefs } from './queueItemRef';

const LEGACY_TRACK = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
const LEGACY_ALBUM = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

describe('playback identity write boundaries', () => {
  beforeEach(() => {
    deactivateCanonicalNavidromeOwners(['srv-a', 'a.test']);
    useAuthStore.setState({
      servers: [{ id: 'srv-a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' }],
      activeServerId: 'srv-a',
    });
  });

  it('canonicalizes stale full tracks and thin refs after owner activation', () => {
    activateCanonicalNavidromeOwners(['srv-a', 'a.test']);
    const staleTrack = {
      id: LEGACY_TRACK,
      title: 'Track',
      artist: 'Artist',
      album: 'Album',
      albumId: LEGACY_ALBUM,
      artistId: LEGACY_ALBUM,
      coverArt: LEGACY_ALBUM,
      duration: 1,
      serverId: 'srv-a',
    };

    expect(canonicalizePlaybackTrack(staleTrack)).toMatchObject({
      id: canonicalizeNavidromeId(LEGACY_TRACK),
      albumId: canonicalizeNavidromeId(LEGACY_ALBUM),
      artistId: canonicalizeNavidromeId(LEGACY_ALBUM),
      coverArt: canonicalizeNavidromeId(LEGACY_ALBUM),
    });
    expect(toQueueItemRefs('srv-a', [staleTrack])).toEqual([{
      serverId: 'a.test',
      trackId: canonicalizeNavidromeId(LEGACY_TRACK),
    }]);
  });
});
