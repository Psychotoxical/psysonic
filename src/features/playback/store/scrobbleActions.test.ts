import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTrack, seedQueue } from '@/test/helpers/factories';
import { resetAllStores } from '@/test/helpers/storeReset';

const submitTrackScrobble = vi.hoisted(() => vi.fn());

vi.mock('@/features/playback/store/submitTrackScrobble', () => ({
  submitTrackScrobble,
}));

import { usePlayerStore } from './playerStore';
import { usePreviewStore } from './previewStore';
import { forceScrobbleCurrentTrack } from './scrobbleActions';
import { useAuthStore } from '@/store/authStore';
import { emitPlaybackProgress } from './playbackProgress';
import { _resetScrobblePlaySessionForTest } from './scrobblePlaySession';

beforeEach(() => {
  resetAllStores();
  submitTrackScrobble.mockClear();
  _resetScrobblePlaySessionForTest();
  useAuthStore.setState({ forceScrobbleEnabled: true });
});

describe('forceScrobbleCurrentTrack', () => {
  it('submits once and marks the play-through scrobbled', () => {
    const track = makeTrack({ id: 't-force' });
    seedQueue([track], { index: 0, currentTrack: track });

    expect(forceScrobbleCurrentTrack(true)).toBe(true);
    expect(usePlayerStore.getState().scrobbled).toBe(true);
    expect(submitTrackScrobble).toHaveBeenCalledTimes(1);

    expect(forceScrobbleCurrentTrack(true)).toBe(false);
    expect(submitTrackScrobble).toHaveBeenCalledTimes(1);
  });

  it('refuses radio, missing tracks, previews, and disallowed submissions', () => {
    expect(forceScrobbleCurrentTrack(true)).toBe(false);

    const track = makeTrack();
    seedQueue([track], { index: 0, currentTrack: track });
    usePlayerStore.setState({ currentRadio: { id: 'r1', name: 'Radio', streamUrl: 'http://x' } as never });
    expect(forceScrobbleCurrentTrack(true)).toBe(false);

    usePlayerStore.setState({ currentRadio: null, scrobbled: false });
    usePreviewStore.setState({ previewingId: 'preview' });
    expect(forceScrobbleCurrentTrack(true)).toBe(false);
    usePreviewStore.setState({ previewingId: null });
    expect(forceScrobbleCurrentTrack(false)).toBe(false);
    expect(submitTrackScrobble).not.toHaveBeenCalled();
  });

  it('keeps the outgoing track paired with its own server during a deferred handoff', () => {
    const outgoing = makeTrack({ id: 'outgoing', serverId: 'server-a' });
    const incoming = makeTrack({ id: 'incoming', serverId: 'server-b' });
    seedQueue([outgoing, incoming], { index: 0, currentTrack: outgoing });
    usePlayerStore.setState({ queueIndex: 1 });

    expect(forceScrobbleCurrentTrack(true)).toBe(true);
    expect(submitTrackScrobble).toHaveBeenCalledWith(
      outgoing,
      'server-a',
      expect.any(Number),
    );
  });

  it('uses restored paused time instead of stale progress from the previous track', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const track = makeTrack({ id: 'restored-paused', serverId: 'server-a' });
    seedQueue([track], { index: 0, currentTrack: track });
    usePlayerStore.setState({ currentTime: 12, isPlaying: false });
    emitPlaybackProgress({ currentTime: 90, progress: 0.9, buffered: 0, buffering: false });

    expect(forceScrobbleCurrentTrack(true)).toBe(true);
    expect(submitTrackScrobble).toHaveBeenCalledWith(track, 'server-a', 88_000);
    now.mockRestore();
  });
});
