import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { onInvoke } from '../test/mocks/tauri';
import { useLibraryIndexStore } from './libraryIndexStore';
import {
  _resetPlayListenSessionForTest,
  playListenSessionFinalize,
  playListenSessionOnProgress,
  playListenSessionOpen,
  resolveDurationSecHint,
} from './playListenSession';
import { onPlaySessionRecorded } from './playSessionRecorded';

vi.mock('../utils/library/libraryReady', () => ({
  libraryIsReady: vi.fn(async () => true),
}));

vi.mock('../utils/playback/playbackServer', () => ({
  getPlaybackServerId: vi.fn(() => 'server-1'),
}));

import type { Track } from './playerStoreTypes';

const testTrack: Track = {
  id: 't1',
  title: 'A',
  artist: 'B',
  album: '',
  albumId: '',
  duration: 180,
};

describe('playListenSession', () => {
  beforeEach(async () => {
    _resetPlayListenSessionForTest();
    useLibraryIndexStore.setState({
      masterEnabled: true,
      syncExcludedByServer: {},
    });
    const { usePlayerStore } = await import('./playerStore');
    const { usePreviewStore } = await import('./previewStore');
    usePlayerStore.setState({
      currentRadio: null,
      isPlaying: true,
      currentTrack: testTrack,
    });
    usePreviewStore.setState({ previewingId: null });
    onInvoke('library_record_play_session', () => undefined);
  });

  it('does not invoke when listenedSec <= 10', async () => {
    await playListenSessionOpen(testTrack, 'server-1');
    await playListenSessionOnProgress(5, false);
    await playListenSessionFinalize('ended');
    expect(invoke).not.toHaveBeenCalledWith('library_record_play_session', expect.anything());
  });

  it('invokes once after >10s listened', async () => {
    vi.useFakeTimers();
    await playListenSessionOpen(testTrack, 'server-1');
    vi.setSystemTime(Date.now() + 15_000);
    await playListenSessionOnProgress(12, false);
    await playListenSessionFinalize('ended');
    vi.useRealTimers();
    expect(invoke).toHaveBeenCalledWith(
      'library_record_play_session',
      expect.objectContaining({
        input: expect.objectContaining({
          trackId: 't1',
          serverId: 'server-1',
          endReason: 'ended',
          durationSecHint: 180,
        }),
      }),
    );
  });

  it('picks up engine duration from progress ticks', async () => {
    const { usePlayerStore } = await import('./playerStore');
    usePlayerStore.setState({
      currentTrack: { ...testTrack, duration: 0 },
    });
    vi.useFakeTimers();
    await playListenSessionOpen({ ...testTrack, duration: 0 }, 'server-1', 240);
    vi.setSystemTime(Date.now() + 15_000);
    await playListenSessionOnProgress(12, false, 240);
    await playListenSessionFinalize('ended');
    vi.useRealTimers();
    expect(invoke).toHaveBeenCalledWith(
      'library_record_play_session',
      expect.objectContaining({
        input: expect.objectContaining({ durationSecHint: 240 }),
      }),
    );
  });

  it('skips when index disabled', async () => {
    useLibraryIndexStore.setState({ masterEnabled: false });
    await playListenSessionOpen(testTrack, 'server-1');
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 20_000);
    await playListenSessionOnProgress(15, false);
    await playListenSessionFinalize('ended');
    vi.useRealTimers();
    expect(invoke).not.toHaveBeenCalledWith('library_record_play_session', expect.anything());
  });

  it('skips preview playback', async () => {
    const { usePreviewStore } = await import('./previewStore');
    usePreviewStore.setState({ previewingId: 'preview-1' });
    vi.useFakeTimers();
    await playListenSessionOpen(testTrack, 'server-1');
    vi.setSystemTime(Date.now() + 20_000);
    await playListenSessionOnProgress(15, false);
    await playListenSessionFinalize('ended');
    vi.useRealTimers();
    expect(invoke).not.toHaveBeenCalledWith('library_record_play_session', expect.anything());
  });

  it('skips radio playback', async () => {
    const { usePlayerStore } = await import('./playerStore');
    usePlayerStore.setState({
      currentRadio: { id: 'r1', name: 'Radio', streamUrl: 'http://x' },
    });
    vi.useFakeTimers();
    await playListenSessionOpen(testTrack, 'server-1');
    vi.setSystemTime(Date.now() + 20_000);
    await playListenSessionOnProgress(15, false);
    await playListenSessionFinalize('ended');
    vi.useRealTimers();
    expect(invoke).not.toHaveBeenCalledWith('library_record_play_session', expect.anything());
  });

  it('does not accumulate listened time while paused or buffering', async () => {
    const { usePlayerStore } = await import('./playerStore');
    vi.useFakeTimers();
    await playListenSessionOpen(testTrack, 'server-1');
    vi.setSystemTime(Date.now() + 15_000);
    usePlayerStore.setState({ isPlaying: false });
    await playListenSessionOnProgress(12, false);
    vi.setSystemTime(Date.now() + 30_000);
    await playListenSessionOnProgress(12, true);
    await playListenSessionFinalize('ended');
    vi.useRealTimers();
    expect(invoke).not.toHaveBeenCalledWith('library_record_play_session', expect.anything());
  });

  it('skips when library is not ready', async () => {
    const { libraryIsReady } = await import('../utils/library/libraryReady');
    vi.mocked(libraryIsReady).mockResolvedValueOnce(false);
    vi.useFakeTimers();
    await playListenSessionOpen(testTrack, 'server-1');
    vi.setSystemTime(Date.now() + 20_000);
    await playListenSessionOnProgress(15, false);
    await playListenSessionFinalize('ended');
    vi.useRealTimers();
    expect(invoke).not.toHaveBeenCalledWith('library_record_play_session', expect.anything());
  });

  it('emits play-session-recorded after a persisted listen', async () => {
    const listener = vi.fn();
    const unsub = onPlaySessionRecorded(listener);
    vi.useFakeTimers();
    await playListenSessionOpen(testTrack, 'server-1');
    vi.setSystemTime(Date.now() + 15_000);
    await playListenSessionOnProgress(12, false);
    await playListenSessionFinalize('ended');
    vi.useRealTimers();
    unsub();
    expect(listener).toHaveBeenCalledWith({
      serverId: 'server-1',
      trackId: 't1',
      startedAtMs: expect.any(Number),
    });
  });
});

describe('resolveDurationSecHint', () => {
  it('returns zero when no positive durations are available', () => {
    expect(resolveDurationSecHint(null)).toBe(0);
    expect(resolveDurationSecHint({ duration: 0 }, 0, undefined)).toBe(0);
  });

  it('prefers the largest finite positive hint', () => {
    expect(resolveDurationSecHint({ duration: 180 }, 240, 200)).toBe(240);
  });
});
