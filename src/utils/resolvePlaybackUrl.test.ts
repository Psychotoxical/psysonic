/**
 * `resolvePlaybackUrl` precedence + `streamUrlTrackId` parser tests (Phase F3).
 *
 * Precedence pinned by the function: offline → hot cache → HTTP stream.
 * Refactors that reorder this break playback for users with offline /
 * hot-cache entries.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useOfflineStore } from '@/store/offlineStore';
import { useHotCacheStore } from '@/store/hotCacheStore';

import {
  getPlaybackSourceKind,
  resolvePlaybackUrl,
  streamUrlTrackId,
} from './resolvePlaybackUrl';
import { useAuthStore } from '@/store/authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';

beforeEach(() => {
  resetAuthStore();
  // Reset the offline + hot-cache store getLocalUrl mocks before each test.
  vi.spyOn(useOfflineStore.getState(), 'getLocalUrl').mockReturnValue(null);
  vi.spyOn(useHotCacheStore.getState(), 'getLocalUrl').mockReturnValue(null);
  // Set up an active server so buildStreamUrl works.
  const id = useAuthStore.getState().addServer({
    name: 'Test', url: 'https://music.example.com', username: 'alice', password: 'pw',
  });
  useAuthStore.getState().setActiveServer(id);
});

describe('resolvePlaybackUrl — precedence', () => {
  it('returns the offline URL when present (1st priority)', () => {
    vi.mocked(useOfflineStore.getState().getLocalUrl).mockReturnValue('psysonic-local://offline/track-1.flac');
    vi.mocked(useHotCacheStore.getState().getLocalUrl).mockReturnValue('psysonic-local://hot/track-1.flac');
    expect(resolvePlaybackUrl('track-1', 'srv-1')).toBe('psysonic-local://offline/track-1.flac');
  });

  it('falls through to the hot-cache URL when offline is absent (2nd priority)', () => {
    vi.mocked(useOfflineStore.getState().getLocalUrl).mockReturnValue(null);
    vi.mocked(useHotCacheStore.getState().getLocalUrl).mockReturnValue('psysonic-local://hot/track-1.flac');
    expect(resolvePlaybackUrl('track-1', 'srv-1')).toBe('psysonic-local://hot/track-1.flac');
  });

  it('falls through to the HTTP stream URL when neither local source is present', () => {
    const url = resolvePlaybackUrl('track-1', 'srv-1');
    expect(url).toMatch(/^https:\/\/music\.example\.com\/rest\/stream\.view\?/);
    expect(url).toContain('id=track-1');
  });

  it('forwards trackId + serverId to both stores so per-server entries scope correctly', () => {
    resolvePlaybackUrl('track-7', 'srv-3');
    expect(useOfflineStore.getState().getLocalUrl).toHaveBeenCalledWith('track-7', 'srv-3');
    expect(useHotCacheStore.getState().getLocalUrl).toHaveBeenCalledWith('track-7', 'srv-3');
  });
});

describe('getPlaybackSourceKind', () => {
  it('returns "offline" when the offline store has the track', () => {
    vi.mocked(useOfflineStore.getState().getLocalUrl).mockReturnValue('psysonic-local://offline/t1.flac');
    expect(getPlaybackSourceKind('t1', 'srv-1')).toBe('offline');
  });

  it('returns "hot" when only the hot-cache has the track', () => {
    vi.mocked(useHotCacheStore.getState().getLocalUrl).mockReturnValue('psysonic-local://hot/t1.flac');
    expect(getPlaybackSourceKind('t1', 'srv-1')).toBe('hot');
  });

  it('returns "stream" when neither has the track and no engine preload hint matches', () => {
    expect(getPlaybackSourceKind('t1', 'srv-1')).toBe('stream');
  });

  it('returns "hot" when the engine reported a preload for this trackId (RAM-loaded)', () => {
    expect(getPlaybackSourceKind('t1', 'srv-1', 't1')).toBe('hot');
  });

  it('returns "stream" when the engine preload hint is for a different track', () => {
    expect(getPlaybackSourceKind('t1', 'srv-1', 'other-track')).toBe('stream');
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

  it('returns null when the URL has no query string', () => {
    expect(streamUrlTrackId('https://music.example.com/rest/stream.view')).toBeNull();
  });

  it('returns null when stream.view URL lacks an id param', () => {
    expect(streamUrlTrackId('https://music.example.com/rest/stream.view?u=alice')).toBeNull();
  });

  it('decodes URL-encoded id values', () => {
    expect(streamUrlTrackId('https://x/rest/stream.view?id=AC%2FDC%20Back')).toBe('AC/DC Back');
  });

  it('falls back to manual query parsing when URL constructor would throw', () => {
    // Relative path — `new URL(...)` requires a base, so the function's
    // manual fallback parses the query directly.
    const url = '/rest/stream.view?id=relative-track&u=u';
    expect(streamUrlTrackId(url)).toBe('relative-track');
  });
});
