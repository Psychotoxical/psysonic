import { describe, expect, it } from 'vitest';
import {
  isActivePublicShareQueue,
  isPublicSharePersistedTrack,
  isPublicShareTrackId,
} from '@/lib/share/navidromePublicSharePlayback';

describe('isActivePublicShareQueue', () => {
  it('detects share queue by queueServerId', () => {
    expect(isActivePublicShareQueue('navidrome-public-share', [
      { serverId: 'navidrome-public-share', trackId: 'ndshare:abc:0' },
    ])).toBe(true);
  });

  it('detects ndshare refs on another queueServerId', () => {
    expect(isActivePublicShareQueue('music.test', [{
      serverId: 'navidrome-public-share',
      trackId: 'ndshare:abc:0',
    }])).toBe(true);
  });

  it('returns false for a normal server queue', () => {
    expect(isActivePublicShareQueue('music.test', [
      { serverId: 'music.test', trackId: 'real-track-id' },
    ])).toBe(false);
  });

  it('returns false for an empty queue', () => {
    expect(isActivePublicShareQueue('navidrome-public-share', [])).toBe(false);
  });
});

describe('isPublicShareTrackId', () => {
  it('matches ndshare synthetic ids', () => {
    expect(isPublicShareTrackId('ndshare:Ab12:0')).toBe(true);
    expect(isPublicShareTrackId('real-id')).toBe(false);
  });
});

describe('isPublicSharePersistedTrack', () => {
  it('matches share currentTrack blobs', () => {
    expect(isPublicSharePersistedTrack({
      id: 'ndshare:abc:0',
      title: 't',
      artist: 'a',
      album: 'al',
      albumId: '',
      duration: 1,
      serverId: 'navidrome-public-share',
    })).toBe(true);
  });
});
