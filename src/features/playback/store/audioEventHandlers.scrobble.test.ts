import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTrack } from '@/test/helpers/factories';
import { resetAllStores } from '@/test/helpers/storeReset';
import { onInvoke } from '@/test/mocks/tauri';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from './playerStore';

const submitTrackScrobble = vi.hoisted(() => vi.fn());

vi.mock('@/features/playback/store/submitTrackScrobble', () => ({
  submitTrackScrobble,
}));

vi.mock('@/lib/api/audio', () => ({
  audioSetAutodjSuppress: vi.fn(async () => undefined),
  audioPreload: vi.fn(async () => undefined),
}));

import { handleAudioEnded, handleAudioProgress } from './audioEventHandlers';

beforeEach(() => {
  resetAllStores();
  submitTrackScrobble.mockClear();
  onInvoke('audio_set_autodj_suppress', () => undefined);
  onInvoke('audio_preload', () => undefined);
});

describe('handleAudioProgress scrobble threshold', () => {
  it('does not scrobble below the configured percentage', () => {
    const track = makeTrack({ duration: 100 });
    usePlayerStore.setState({ currentTrack: track, isPlaying: true, scrobbled: false });
    useAuthStore.setState({ scrobbleThresholdPercent: 75 });

    handleAudioProgress(74, 100);

    expect(usePlayerStore.getState().scrobbled).toBe(false);
    expect(submitTrackScrobble).not.toHaveBeenCalled();
  });

  it('scrobbles once when progress crosses the configured percentage', () => {
    const track = makeTrack({ duration: 100 });
    usePlayerStore.setState({ currentTrack: track, isPlaying: true, scrobbled: false });
    useAuthStore.setState({ scrobbleThresholdPercent: 25 });

    handleAudioProgress(25, 100);
    handleAudioProgress(80, 100);

    expect(usePlayerStore.getState().scrobbled).toBe(true);
    expect(submitTrackScrobble).toHaveBeenCalledTimes(1);
  });

  it('settles a high-threshold play when an early crossfade boundary ends progress', () => {
    vi.useFakeTimers();
    const track = makeTrack({ duration: 100 });
    usePlayerStore.setState({ currentTrack: track, isPlaying: true, scrobbled: false });
    useAuthStore.setState({ scrobbleThresholdPercent: 90 });

    handleAudioProgress(82, 100);
    expect(submitTrackScrobble).not.toHaveBeenCalled();

    handleAudioEnded();
    expect(usePlayerStore.getState().scrobbled).toBe(true);
    expect(submitTrackScrobble).toHaveBeenCalledTimes(1);
    vi.clearAllTimers();
    vi.useRealTimers();
  });
});
