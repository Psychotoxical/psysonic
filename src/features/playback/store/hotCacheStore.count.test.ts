import { describe, expect, it } from 'vitest';
import type { LocalPlaybackEntry } from '@/store/localPlaybackStore';
import { countHotCacheTracks } from '@/features/playback/store/hotCacheStore';

function ephemeral(
  serverIndexKey: string,
  trackId: string,
): LocalPlaybackEntry {
  return {
    serverIndexKey,
    trackId,
    localPath: `/media/cache/${trackId}.mp3`,
    sizeBytes: 1_000,
    layoutFingerprint: 'fp',
    tier: 'ephemeral',
    suffix: 'mp3',
    cachedAt: Date.parse('2026-01-01T00:00:00.000Z'),
  };
}

describe('countHotCacheTracks', () => {
  it('counts all ephemeral rows regardless of server index key shape', () => {
    const entries = {
      '192.168.0.5:4533:t1': ephemeral('192.168.0.5:4533', 't1'),
      'srv-uuid:t2': ephemeral('srv-uuid', 't2'),
      'srv-uuid:t3': { ...ephemeral('srv-uuid', 't3'), tier: 'library' as const },
    };
    expect(countHotCacheTracks(entries)).toBe(2);
  });

  it('ignores non-ephemeral tiers', () => {
    const entries = {
      'srv:t1': ephemeral('srv', 't1'),
      'srv:t2': { ...ephemeral('srv', 't2'), tier: 'favorite-auto' as const },
    };
    expect(countHotCacheTracks(entries)).toBe(1);
  });
});
