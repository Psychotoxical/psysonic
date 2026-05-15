/**
 * Promote-stream-cache helper: wraps a single Rust IPC and forwards the
 * result into the hot-cache store index. Tests pin the payload shape, the
 * suffix fallback, the null-result skip, and the swallow-on-error
 * contract.
 */
import type { Track } from './playerStoreTypes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { invokeMock, setEntryMock, buildStreamUrlMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => null as { path: string; size: number } | null),
  setEntryMock: vi.fn(),
  buildStreamUrlMock: vi.fn((id: string) => `https://mock/stream/${id}`),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('../api/subsonicStreamUrl', () => ({
  buildStreamUrl: buildStreamUrlMock,
  buildStreamUrlForServer: (_serverId: string, id: string) => buildStreamUrlMock(id),
}));
vi.mock('./hotCacheStore', () => ({
  useHotCacheStore: { getState: () => ({ setEntry: setEntryMock }) },
}));

import { promoteCompletedStreamToHotCache } from './promoteStreamCache';

function track(id: string, overrides: Partial<Track> = {}): Track {
  return { id, title: id, artist: 'A', album: 'X', albumId: 'X', duration: 100, ...overrides };
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  setEntryMock.mockReset();
  buildStreamUrlMock.mockClear();
});

describe('promoteCompletedStreamToHotCache', () => {
  it('forwards a complete payload to the Rust command', async () => {
    invokeMock.mockResolvedValueOnce({ path: '/cache/t1.mp3', size: 1234 });
    await promoteCompletedStreamToHotCache(track('t1', { suffix: 'flac' }), 'srv', '/hot');
    expect(invokeMock).toHaveBeenCalledWith('promote_stream_cache_to_hot_cache', {
      trackId: 't1',
      serverId: 'srv',
      url: 'https://mock/stream/t1',
      suffix: 'flac',
      customDir: '/hot',
    });
  });

  it("falls back to suffix='mp3' when the track has no suffix", async () => {
    invokeMock.mockResolvedValueOnce({ path: '/cache/t1.mp3', size: 100 });
    await promoteCompletedStreamToHotCache(track('t1'), 'srv', null);
    expect(invokeMock.mock.calls[0][1]?.suffix).toBe('mp3');
  });

  it('passes through customDir=null when the user has no hot-cache dir set', async () => {
    invokeMock.mockResolvedValueOnce({ path: '/cache/t1.mp3', size: 100 });
    await promoteCompletedStreamToHotCache(track('t1'), 'srv', null);
    expect(invokeMock.mock.calls[0][1]?.customDir).toBeNull();
  });

  it('records the entry in the hot-cache store on a successful path', async () => {
    invokeMock.mockResolvedValueOnce({ path: '/cache/t1.mp3', size: 5678 });
    await promoteCompletedStreamToHotCache(track('t1'), 'srv', null);
    expect(setEntryMock).toHaveBeenCalledWith('t1', 'srv', '/cache/t1.mp3', 5678, 'stream-promote');
  });

  it('defaults size to 0 when Rust omits it', async () => {
    invokeMock.mockResolvedValueOnce({ path: '/cache/t1.mp3', size: 0 });
    await promoteCompletedStreamToHotCache(track('t1'), 'srv', null);
    expect(setEntryMock.mock.calls[0][3]).toBe(0);
  });

  it('skips the hot-cache write when Rust returns null', async () => {
    invokeMock.mockResolvedValueOnce(null);
    await promoteCompletedStreamToHotCache(track('t1'), 'srv', null);
    expect(setEntryMock).not.toHaveBeenCalled();
  });

  it('skips the hot-cache write when path is empty', async () => {
    invokeMock.mockResolvedValueOnce({ path: '', size: 100 });
    await promoteCompletedStreamToHotCache(track('t1'), 'srv', null);
    expect(setEntryMock).not.toHaveBeenCalled();
  });

  it('swallows Rust errors silently', async () => {
    invokeMock.mockRejectedValueOnce(new Error('boom'));
    await expect(promoteCompletedStreamToHotCache(track('t1'), 'srv', null)).resolves.toBeUndefined();
    expect(setEntryMock).not.toHaveBeenCalled();
  });
});
