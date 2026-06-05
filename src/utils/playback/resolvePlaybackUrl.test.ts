/**
 * `resolvePlaybackUrl` precedence + `streamUrlTrackId` parser tests (Phase F3).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getLocalUrlMock } = vi.hoisted(() => ({
  getLocalUrlMock: vi.fn(),
}));

vi.mock('@/store/localPlaybackStore', () => ({
  useLocalPlaybackStore: {
    getState: () => ({ getLocalUrl: getLocalUrlMock, entries: {} }),
    subscribe: vi.fn(),
  },
}));

import {
  getPlaybackSourceKind,
  resolvePlaybackUrl,
  streamUrlTrackId,
} from './resolvePlaybackUrl';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';

beforeEach(() => {
  resetAuthStore();
  getLocalUrlMock.mockReset();
  getLocalUrlMock.mockReturnValue(null);
  const id = useAuthStore.getState().addServer({
    name: 'Test', url: 'https://music.example.com', username: 'alice', password: 'pw',
  });
  useAuthStore.getState().setActiveServer(id);
});

describe('resolvePlaybackUrl — precedence', () => {
  it('returns the library-tier URL when present (1st priority)', () => {
    getLocalUrlMock.mockImplementation(
      (_tid: string, _sid: string, tier?: string) => (tier === 'library' ? 'psysonic-local://library/track-1.flac' : null),
    );
    expect(resolvePlaybackUrl('track-1', 'srv-1')).toBe('psysonic-local://library/track-1.flac');
  });

  it('falls through to ephemeral cache when library is absent (2nd priority)', () => {
    getLocalUrlMock.mockImplementation(
      (_tid: string, _sid: string, tier?: string) => (tier === 'ephemeral' || tier === undefined ? 'psysonic-local://hot/track-1.flac' : null),
    );
    expect(resolvePlaybackUrl('track-1', 'srv-1')).toBe('psysonic-local://hot/track-1.flac');
  });

  it('falls through to the HTTP stream URL when neither local source is present', () => {
    const url = resolvePlaybackUrl('track-1', 'srv-1');
    expect(url).toMatch(/^https:\/\/music\.example\.com\/rest\/stream\.view\?/);
    expect(url).toContain('id=track-1');
  });
});

describe('getPlaybackSourceKind', () => {
  it('returns "offline" when the library tier has the track', () => {
    getLocalUrlMock.mockImplementation(
      (_tid: string, _sid: string, tier?: string) => (tier === 'library' ? 'psysonic-local://library/t1.flac' : null),
    );
    expect(getPlaybackSourceKind('t1', 'srv-1')).toBe('offline');
  });

  it('returns "hot" when only ephemeral cache has the track', () => {
    getLocalUrlMock.mockImplementation(
      (_tid: string, _sid: string, tier?: string) => (tier === 'ephemeral' ? 'psysonic-local://hot/t1.flac' : null),
    );
    expect(getPlaybackSourceKind('t1', 'srv-1')).toBe('hot');
  });

  it('returns "stream" when neither has the track and no engine preload hint matches', () => {
    expect(getPlaybackSourceKind('t1', 'srv-1')).toBe('stream');
  });

  it('returns "hot" when the engine reported a preload for this trackId (RAM-loaded)', () => {
    expect(getPlaybackSourceKind('t1', 'srv-1', 't1')).toBe('hot');
  });
});

describe('streamUrlTrackId', () => {
  it('extracts the id query param from a stream.view URL', () => {
    const url = 'https://music.example.com/rest/stream.view?id=track-1&u=alice&t=hash';
    expect(streamUrlTrackId(url)).toBe('track-1');
  });

  it('returns null for URLs that are not stream.view', () => {
    expect(streamUrlTrackId('https://music.example.com/rest/getCoverArt.view?id=cover')).toBeNull();
  });
});
