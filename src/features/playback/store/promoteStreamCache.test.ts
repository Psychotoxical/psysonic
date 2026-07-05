import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '@/lib/media/trackTypes';

const invokeMock = vi.fn();
const setEntryMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@/features/playback/store/hotCacheStore', () => ({
  useHotCacheStore: {
    getState: () => ({ setEntry: setEntryMock }),
  },
}));

vi.mock('@/lib/media/mediaDir', () => ({
  getMediaDir: () => '/media',
}));

vi.mock('@/lib/api/subsonicStreamUrl', () => ({
  buildStreamUrlForServer: (_sid: string, id: string) => `https://mock/stream/${id}`,
}));

vi.mock('@/lib/api/coverCache', () => ({
  librarySqlServerId: (k: string) => k,
}));

const hasLocalPersistentPlaybackBytesMock = vi.fn((_trackId: string, _serverId: string) => false);

vi.mock('@/store/localPlaybackResolve', () => ({
  hasLocalPersistentPlaybackBytes: (trackId: string, serverId: string) =>
    hasLocalPersistentPlaybackBytesMock(trackId, serverId),
}));

import { promoteCompletedStreamToHotCache } from '@/features/playback/store/promoteStreamCache';

function track(id: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    title: 'T',
    artist: 'A',
    album: 'Al',
    albumId: 'al-1',
    duration: 100,
    ...overrides,
  };
}

describe('promoteCompletedStreamToHotCache', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setEntryMock.mockReset();
    hasLocalPersistentPlaybackBytesMock.mockReset();
    hasLocalPersistentPlaybackBytesMock.mockReturnValue(false);
  });

  it('skips promote when library or favorites already have bytes', async () => {
    hasLocalPersistentPlaybackBytesMock.mockReturnValue(true);
    await promoteCompletedStreamToHotCache(track('t1'), 'srv', null);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(setEntryMock).not.toHaveBeenCalled();
  });

  it('forwards a complete payload to the Rust command', async () => {
    invokeMock.mockResolvedValueOnce({
      path: '/media/cache/t1.mp3',
      size: 1234,
      layoutFingerprint: 'fp1',
    });
    await promoteCompletedStreamToHotCache(track('t1', { suffix: 'flac' }), 'srv', null);
    expect(invokeMock).toHaveBeenCalledWith('promote_stream_cache_to_local', {
      trackId: 't1',
      serverIndexKey: 'srv',
      libraryServerId: 'srv',
      url: expect.stringContaining('t1'),
      suffix: 'flac',
      mediaDir: '/media',
    });
  });

  it('defaults suffix to mp3', async () => {
    invokeMock.mockResolvedValueOnce({ path: '/p', size: 1, layoutFingerprint: '' });
    await promoteCompletedStreamToHotCache(track('t1'), 'srv', null);
    expect(invokeMock.mock.calls[0][1]?.suffix).toBe('mp3');
  });

  it('stores entry when Rust returns a path', async () => {
    invokeMock.mockResolvedValueOnce({
      path: '/media/cache/t1.mp3',
      size: 5678,
      layoutFingerprint: 'fp',
    });
    await promoteCompletedStreamToHotCache(track('t1'), 'srv', null);
    expect(setEntryMock).toHaveBeenCalledWith(
      't1',
      'srv',
      '/media/cache/t1.mp3',
      5678,
      'stream-promote',
      'fp',
      'mp3',
    );
  });

  it('swallows invoke errors', async () => {
    invokeMock.mockRejectedValueOnce(new Error('fail'));
    await expect(promoteCompletedStreamToHotCache(track('t1'), 'srv', null)).resolves.toBeUndefined();
    expect(setEntryMock).not.toHaveBeenCalled();
  });
});
