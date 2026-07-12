import { describe, expect, it } from 'vitest';
import { isPersistedPublicShareQueue } from '@/lib/share/navidromePublicSharePlayback';

describe('isPersistedPublicShareQueue', () => {
  it('detects share queue by queueServerId', () => {
    expect(isPersistedPublicShareQueue('navidrome-public-share', [
      { serverId: 'navidrome-public-share', trackId: 'ndshare:abc:0' },
    ])).toBe(true);
  });

  it('detects share refs with direct stream URLs', () => {
    expect(isPersistedPublicShareQueue('music.test', [{
      serverId: 'navidrome-public-share',
      trackId: 'ndshare:abc:0',
      directStreamUrl: 'https://music.test/share/s/jwt',
    }])).toBe(true);
  });

  it('detects ndshare track ids even when direct URLs were not persisted yet', () => {
    expect(isPersistedPublicShareQueue('music.test', [{
      serverId: 'navidrome-public-share',
      trackId: 'ndshare:abc:0',
    }])).toBe(true);
  });

  it('returns false for a normal server queue', () => {
    expect(isPersistedPublicShareQueue('music.test', [
      { serverId: 'music.test', trackId: 'real-track-id' },
    ])).toBe(false);
  });
});
