import { describe, expect, it, beforeEach } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import {
  bindQueueServerForPlayback,
  bindQueueServerForTracks,
  clearQueueServerForPlayback,
  ensurePlaybackServerActive,
  getPlaybackServerId,
  playbackCacheKeyForTrack,
  playbackCoverArtForId,
  playbackServerDiffersFromActive,
  prepareActiveServerForNewMix,
  shouldBindQueueServerForPlay,
  shouldHandoffQueueToActiveServer,
} from '@/features/playback/utils/playback/playbackServer';
import { invoke } from '@tauri-apps/api/core';
import { vi } from 'vitest';

vi.mock('@/utils/server/switchActiveServer', () => ({
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
      queueItems: [{ serverId: 'a', trackId: 't1' }],
      queueServerId: 'a',
      queueIndex: 0,
    });
  });

  it('getPlaybackServerId returns queue server while queue is non-empty', () => {
    useAuthStore.setState({ activeServerId: 'b' });
    expect(getPlaybackServerId()).toBe('a');
  });

  it('getPlaybackServerId follows the playing ref in a mixed-server queue', () => {
    useAuthStore.setState({ activeServerId: 'a' });
    usePlayerStore.setState({
      queueItems: [
        { serverId: 'a.test', trackId: 't1' },
        { serverId: 'b.test', trackId: 't2' },
      ],
      queueServerId: 'a.test',
      queueIndex: 1,
    });
    expect(getPlaybackServerId()).toBe('b');
  });

  it('getPlaybackServerId falls back to active when queue is empty', () => {
    clearQueueServerForPlayback();
    usePlayerStore.setState({ queueItems: [] });
    useAuthStore.setState({ activeServerId: 'b' });
    expect(getPlaybackServerId()).toBe('b');
  });

  it('bindQueueServerForPlayback pins active server as canonical index key', () => {
    useAuthStore.setState({ activeServerId: 'b' });
    bindQueueServerForPlayback();
    // B1: writers emit the canonical (URL-derived) server key, not the UUID.
    expect(usePlayerStore.getState().queueServerId).toBe('b.test');
  });

  it('playbackServerDiffersFromActive when queue server != active', () => {
    useAuthStore.setState({ activeServerId: 'b' });
    expect(playbackServerDiffersFromActive()).toBe(true);
    usePlayerStore.setState({ queueItems: [] });
    expect(playbackServerDiffersFromActive()).toBe(false);
  });

  it('prepareActiveServerForNewMix clears queue and pins browsed server', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    useAuthStore.setState({ activeServerId: 'b' });
    prepareActiveServerForNewMix();
    const s = usePlayerStore.getState();
    expect(s.queueItems).toEqual([]);
    expect(s.currentTrack).toBeNull();
    // Canonical index key on re-pin (B1).
    expect(s.queueServerId).toBe('b.test');
    expect(playbackServerDiffersFromActive()).toBe(false);
  });

  it('prepareActiveServerForNewMix is a no-op when queue already matches active', () => {
    useAuthStore.setState({ activeServerId: 'a' });
    prepareActiveServerForNewMix();
    expect(usePlayerStore.getState().queueItems).toHaveLength(1);
    // Pre-existing queueServerId='a' (UUID) is tolerated by the reader helpers
    // even while writers emit canonical index keys — this is the migration
    // window the resolver compat path covers (B1).
    expect(usePlayerStore.getState().queueServerId).toBe('a');
  });

  it('shouldHandoffQueueToActiveServer when queue is unpinned but non-empty', () => {
    useAuthStore.setState({ activeServerId: 'b' });
    usePlayerStore.setState({ queueServerId: null });
    expect(shouldHandoffQueueToActiveServer()).toBe(true);
    // Playing ref still owns playback even when queueServerId is unpinned.
    expect(playbackServerDiffersFromActive()).toBe(true);
  });

  it('shouldHandoffQueueToActiveServer when queue server differs from active', () => {
    useAuthStore.setState({ activeServerId: 'b' });
    expect(shouldHandoffQueueToActiveServer()).toBe(true);
  });

  it('ensurePlaybackServerActive calls switch when servers differ', async () => {
    const { switchActiveServer } = await import('@/utils/server/switchActiveServer');
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
    expect(cacheKey).toBe('a.test:cover:album:cov1:128');
  });

  it('shouldBindQueueServerForPlay detects queue replacement', () => {
    // Thin-state: prevQueue is the canonical refs; newQueue / explicit arg are Tracks.
    const prevRefs = [{ serverId: 'a', trackId: 't1' }];
    const sameTrack = [{ id: 't1', title: 'T', artist: 'A', album: 'Al', albumId: 'al1', duration: 100 }];
    const next = [
      { id: 't1', title: 'T', artist: 'A', album: 'Al', albumId: 'al1', duration: 100 },
      { id: 't2', title: 'T2', artist: 'A', album: 'Al', albumId: 'al1', duration: 100 },
    ];
    expect(shouldBindQueueServerForPlay(prevRefs, next, next)).toBe(true);
    expect(shouldBindQueueServerForPlay(prevRefs, sameTrack, undefined)).toBe(false);
  });

  it('bindQueueServerForTracks pins the first track server, not the active server', () => {
    useAuthStore.setState({ activeServerId: 'a' });
    bindQueueServerForTracks([
      { id: 't1', title: 'T', artist: '', album: '', albumId: '', duration: 1, serverId: 'b' },
    ]);
    expect(usePlayerStore.getState().queueServerId).toBe('b.test');
  });

  it('playbackCacheKeyForTrack prefers track.serverId over queue server', () => {
    usePlayerStore.setState({ queueServerId: 'a.test' });
    const key = playbackCacheKeyForTrack({
      id: 't1', title: 'T', artist: '', album: '', albumId: '', duration: 1, serverId: 'b',
    });
    expect(key).toBe('b.test');
  });
});
