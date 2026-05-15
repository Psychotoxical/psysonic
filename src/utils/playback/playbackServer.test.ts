import { describe, expect, it, beforeEach } from 'vitest';
import { useAuthStore } from '../../store/authStore';
import { usePlayerStore } from '../../store/playerStore';
import {
  bindQueueServerForPlayback,
  clearQueueServerForPlayback,
  ensurePlaybackServerActive,
  getPlaybackServerId,
  playbackCoverArtForId,
  playbackServerDiffersFromActive,
  shouldBindQueueServerForPlay,
} from './playbackServer';
import { vi } from 'vitest';

vi.mock('../server/switchActiveServer', () => ({
  switchActiveServer: vi.fn(async () => true),
}));

describe('playbackServer', () => {
  beforeEach(() => {
    useAuthStore.setState({
      servers: [
        { id: 'a', name: 'A', url: 'http://a.test', username: 'u', password: 'p' },
        { id: 'b', name: 'B', url: 'http://b.test', username: 'u', password: 'p' },
      ],
      activeServerId: 'a',
      isLoggedIn: true,
    });
    usePlayerStore.setState({
      queue: [{ id: 't1', title: 'T', artist: 'A', album: 'Al', albumId: 'al1', duration: 100 }],
      queueServerId: 'a',
      queueIndex: 0,
    });
  });

  it('getPlaybackServerId returns queue server while queue is non-empty', () => {
    useAuthStore.setState({ activeServerId: 'b' });
    expect(getPlaybackServerId()).toBe('a');
  });

  it('getPlaybackServerId falls back to active when queue is empty', () => {
    clearQueueServerForPlayback();
    usePlayerStore.setState({ queue: [] });
    useAuthStore.setState({ activeServerId: 'b' });
    expect(getPlaybackServerId()).toBe('b');
  });

  it('bindQueueServerForPlayback pins active server', () => {
    useAuthStore.setState({ activeServerId: 'b' });
    bindQueueServerForPlayback();
    expect(usePlayerStore.getState().queueServerId).toBe('b');
  });

  it('playbackServerDiffersFromActive when queue server != active', () => {
    useAuthStore.setState({ activeServerId: 'b' });
    expect(playbackServerDiffersFromActive()).toBe(true);
    usePlayerStore.setState({ queue: [] });
    expect(playbackServerDiffersFromActive()).toBe(false);
  });

  it('ensurePlaybackServerActive calls switch when servers differ', async () => {
    const { switchActiveServer } = await import('../server/switchActiveServer');
    useAuthStore.setState({ activeServerId: 'b' });
    await ensurePlaybackServerActive();
    expect(switchActiveServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a' }),
    );
  });

  it('playbackCoverArtForId uses queue server credentials when browsing another server', () => {
    useAuthStore.setState({ activeServerId: 'b' });
    const { src, cacheKey } = playbackCoverArtForId('cov1', 128);
    expect(src).toContain('a.test');
    expect(cacheKey).toBe('a:cover:cov1:128');
  });

  it('shouldBindQueueServerForPlay detects queue replacement', () => {
    const prev = [{ id: 't1', title: 'T', artist: 'A', album: 'Al', albumId: 'al1', duration: 100 }];
    const next = [
      { id: 't1', title: 'T', artist: 'A', album: 'Al', albumId: 'al1', duration: 100 },
      { id: 't2', title: 'T2', artist: 'A', album: 'Al', albumId: 'al1', duration: 100 },
    ];
    expect(shouldBindQueueServerForPlay(prev, next, next)).toBe(true);
    expect(shouldBindQueueServerForPlay(prev, prev, undefined)).toBe(false);
  });
});
