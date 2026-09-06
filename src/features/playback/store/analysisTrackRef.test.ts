import { beforeEach, describe, expect, it, vi } from 'vitest';

const servers = vi.hoisted(() => [] as Array<{ id: string; url: string }>);

vi.mock('@/store/authStore', () => ({
  useAuthStore: {
    getState: () => ({ servers }),
  },
}));

import { analysisTrackRef } from '@/features/playback/store/analysisTrackRef';

beforeEach(() => {
  servers.splice(0, servers.length);
});

describe('analysisTrackRef', () => {
  it('rejects an unknown generated profile id instead of using it as a server key', () => {
    const profileId = Date.UTC(2026, 3, 15).toString(36) + 'k2ff7q1zt';
    expect(analysisTrackRef('track-1', profileId)).toEqual({
      trackId: 'track-1',
      serverIndexKey: null,
    });
  });

  it('resolves a known generated profile id through its primary URL', () => {
    const profileId = Date.UTC(2026, 3, 15).toString(36) + 'k2ff7q1zt';
    servers.push({ id: profileId, url: 'https://music.example.test/' });
    expect(analysisTrackRef('track-1', profileId)).toEqual({
      trackId: 'track-1',
      serverIndexKey: 'music.example.test',
    });
  });

  it('keeps the configured index key when it resembles a generated profile id', () => {
    servers.push({ id: 'profile-1', url: 'http://mpserver' });
    expect(analysisTrackRef('track-1', 'mpserver')).toEqual({
      trackId: 'track-1',
      serverIndexKey: 'mpserver',
    });
  });
});
