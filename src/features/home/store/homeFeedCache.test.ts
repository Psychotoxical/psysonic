import { describe, expect, it } from 'vitest';
import {
  clearHomeFeedCache,
  readHomeFeedCache,
  readHomeFeedCacheStale,
  writeHomeFeedCache,
} from '@/features/home/store/homeFeedCache';

const emptyFeed = {
  scopeFingerprint: 'scope-a',
  filterVersion: 1,
  starred: [],
  recent: [],
  random: [],
  heroAlbums: [],
  mostPlayed: [],
  recentlyPlayed: [],
  randomArtists: [],
  discoverSongs: [],
};

describe('homeFeedCache', () => {
  it('keys fresh and stale snapshots by ordered browse fingerprint', () => {
    clearHomeFeedCache();
    writeHomeFeedCache(emptyFeed);

    expect(readHomeFeedCache('scope-a', 1)).not.toBeNull();
    expect(readHomeFeedCache('scope-b', 1)).toBeNull();
    expect(readHomeFeedCacheStale('scope-b')).toBeNull();
  });
});
