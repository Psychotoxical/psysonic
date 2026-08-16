import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTrack, seedQueue } from '@/test/helpers/factories';
import { resetAllStores } from '@/test/helpers/storeReset';

const submitTrackScrobble = vi.hoisted(() => vi.fn());
const isOfflineBrowseActive = vi.hoisted(() => vi.fn(() => false));

vi.mock('@/features/playback/store/submitTrackScrobble', () => ({
  submitTrackScrobble,
}));

vi.mock('@/features/offline/utils/offlineBrowseMode', () => ({
  isOfflineBrowseActive,
  useOfflineBrowseActive: () => isOfflineBrowseActive(),
}));

import { usePlayerStore } from './playerStore';

beforeEach(() => {
  resetAllStores();
  submitTrackScrobble.mockClear();
  isOfflineBrowseActive.mockReturnValue(false);
});

describe('forceScrobbleCurrentTrack', () => {
  it('submits once and marks the play-through scrobbled', () => {
    const track = makeTrack({ id: 't-force' });
    seedQueue([track], { index: 0, currentTrack: track });

    expect(usePlayerStore.getState().forceScrobbleCurrentTrack()).toBe(true);
    expect(usePlayerStore.getState().scrobbled).toBe(true);
    expect(submitTrackScrobble).toHaveBeenCalledTimes(1);

    expect(usePlayerStore.getState().forceScrobbleCurrentTrack()).toBe(false);
    expect(submitTrackScrobble).toHaveBeenCalledTimes(1);
  });

  it('refuses radio, missing tracks, and offline browse', () => {
    expect(usePlayerStore.getState().forceScrobbleCurrentTrack()).toBe(false);

    const track = makeTrack();
    seedQueue([track], { index: 0, currentTrack: track });
    usePlayerStore.setState({ currentRadio: { id: 'r1', name: 'Radio', streamUrl: 'http://x' } as never });
    expect(usePlayerStore.getState().forceScrobbleCurrentTrack()).toBe(false);

    usePlayerStore.setState({ currentRadio: null, scrobbled: false });
    isOfflineBrowseActive.mockReturnValue(true);
    expect(usePlayerStore.getState().forceScrobbleCurrentTrack()).toBe(false);
    expect(submitTrackScrobble).not.toHaveBeenCalled();
  });
});
