import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onInvoke, invokeMock } from '@/test/mocks/tauri';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import {
  _resetGaplessPreloadStateForTest,
  getGaplessPreloadingId,
} from '@/features/playback/store/gaplessPreloadState';
import {
  _resetGaplessChainPrepareInflightForTest,
  requestGaplessChainPreload,
} from '@/features/playback/store/gaplessChainPreload';

const prepareMock = vi.hoisted(() =>
  vi.fn(async (track: Track) => ({
    ...track,
    title: 'Next indexed',
    duration: 180,
    replayGainTrackDb: -5.5,
  })),
);

vi.mock('@/features/playback/utils/audio/prepareTrackForEngineBind', () => ({
  prepareTrackForEngineBind: prepareMock,
}));

const ref = (trackId: string): QueueItemRef => ({ serverId: 's1', trackId });

const track = (id: string, extra: Partial<Track> = {}): Track => ({
  id,
  title: extra.title ?? `Track ${id}`,
  artist: 'Artist',
  album: 'Album',
  albumId: 'alb-1',
  duration: extra.duration ?? 200,
  ...extra,
});

describe('requestGaplessChainPreload', () => {
  beforeEach(() => {
    _resetGaplessPreloadStateForTest();
    _resetGaplessChainPrepareInflightForTest();
    prepareMock.mockClear();
    vi.restoreAllMocks();
    onInvoke('audio_chain_preload', () => undefined);
    useAuthStore.setState({
      activeServerId: 's1',
      servers: [{
        id: 's1',
        name: 'Test',
        url: 'https://music.example',
        username: 'u',
        password: 'p',
      }],
      normalizationEngine: 'replaygain',
      replayGainEnabled: true,
      replayGainMode: 'track',
      replayGainPreGainDb: 0,
      replayGainFallbackDb: -6,
      gaplessEnabled: true,
    });
    usePlayerStore.setState({
      currentTrack: track('t1'),
      queueItems: [ref('t1'), ref('t2')],
      queueIndex: 0,
      repeatMode: 'off',
      isPlaying: true,
      currentRadio: null,
      volume: 0.75,
    });
  });

  it('prefetches metadata then chains with ReplayGain from prepare', async () => {
    requestGaplessChainPreload({
      currentTrack: track('t1'),
      nextTrack: track('t2', { title: '…', duration: 0 }),
      nextRef: ref('t2'),
      nextIdx: 1,
      queueItems: [ref('t1'), ref('t2')],
      repeatMode: 'off',
      volume: 0.75,
    });

    await vi.waitFor(() => {
      expect(getGaplessPreloadingId()).toBe('t2');
    });

    expect(prepareMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't2' }),
      'music.example',
    );
    const chainCalls = invokeMock.mock.calls.filter(c => c[0] === 'audio_chain_preload');
    expect(chainCalls.length).toBe(1);
    expect(chainCalls[0]?.[1]).toMatchObject({
      replayGainDb: -5.5,
      durationHint: 180,
    });
  });

  it('no-ops when playback context changed before prepare finished', async () => {
    requestGaplessChainPreload({
      currentTrack: track('t1'),
      nextTrack: track('t2', { title: '…', duration: 0 }),
      nextRef: ref('t2'),
      nextIdx: 1,
      queueItems: [ref('t1'), ref('t2')],
      repeatMode: 'off',
      volume: 0.75,
    });

    usePlayerStore.setState({ currentTrack: track('t99', { id: 't99' }) });

    await vi.waitFor(() => {
      expect(prepareMock).toHaveBeenCalled();
    });

    expect(getGaplessPreloadingId()).toBeNull();
    expect(invokeMock.mock.calls.filter(c => c[0] === 'audio_chain_preload').length).toBe(0);
  });
});
