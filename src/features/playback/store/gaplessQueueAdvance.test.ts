import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import {
  _resetQueueResolverForTest,
  seedQueueResolver,
} from '@/features/playback/store/queueTrackResolver';
import { _resetGaplessPreloadStateForTest } from '@/features/playback/store/gaplessPreloadState';
import { setSeekTarget, _resetSeekTargetStateForTest } from '@/features/playback/store/seekTargetState';
import {
  _resetPlaybackProgressForTest,
  getPlaybackProgressSnapshot,
} from '@/features/playback/store/playbackProgress';
import {
  _resetGaplessProgressTrackingForTest,
  noteEngineProgressForGapless,
} from '@/features/playback/store/gaplessProgressTracking';
import {
  applyGaplessQueueAdvance,
  maybeReconcileGaplessFromProgress,
} from '@/features/playback/store/gaplessQueueAdvance';

const ref = (trackId: string, serverId = 's1'): QueueItemRef => ({ serverId, trackId });

const track = (id: string, extra: Partial<Track> = {}): Track => ({
  id,
  title: extra.title ?? `Track ${id}`,
  artist: 'Artist',
  album: 'Album',
  albumId: 'alb-1',
  duration: extra.duration ?? 200,
  ...extra,
});

describe('applyGaplessQueueAdvance', () => {
  beforeEach(() => {
    _resetQueueResolverForTest();
    _resetPlaybackProgressForTest();
    onInvoke('audio_update_replay_gain', () => undefined);
    useAuthStore.setState({ gaplessEnabled: true });
    seedQueueResolver('s1', [
      track('t1'),
      track('t2', { title: 'Second' }),
    ]);
    usePlayerStore.setState({
      currentTrack: track('t1'),
      queueItems: [ref('t1'), ref('t2')],
      queueIndex: 0,
      repeatMode: 'off',
      isPlaying: true,
      currentRadio: null,
      progress: 0.8,
      currentTime: 160,
    });
  });

  it('advances currentTrack and resets the progress channel', () => {
    const result = applyGaplessQueueAdvance({ engineDurationHint: 210, source: 'track-switched' });

    expect(result.advanced).toBe(true);
    expect(usePlayerStore.getState().currentTrack?.id).toBe('t2');
    expect(usePlayerStore.getState().queueIndex).toBe(1);
    expect(getPlaybackProgressSnapshot().currentTime).toBe(0);
    expect(getPlaybackProgressSnapshot().progress).toBe(0);
  });

  it('advances between equal raw ids owned by different servers', () => {
    const a = track('shared', { serverId: 'srv-a' });
    const b = track('shared', { serverId: 'srv-b' });
    seedQueueResolver('srv-a', [a]);
    seedQueueResolver('srv-b', [b]);
    usePlayerStore.setState({
      currentTrack: a,
      queueItems: [ref('shared', 'srv-a'), ref('shared', 'srv-b')],
      queueIndex: 0,
    });

    const result = applyGaplessQueueAdvance({ engineDurationHint: 210, source: 'track-switched' });

    expect(result.advanced).toBe(true);
    expect(usePlayerStore.getState().queueIndex).toBe(1);
    expect(usePlayerStore.getState().currentTrack?.serverId).toBe('srv-b');
  });
});

describe('maybeReconcileGaplessFromProgress', () => {
  beforeEach(() => {
    _resetQueueResolverForTest();
    _resetGaplessPreloadStateForTest();
    _resetPlaybackProgressForTest();
    _resetGaplessProgressTrackingForTest();
    _resetSeekTargetStateForTest();
    onInvoke('audio_update_replay_gain', () => undefined);
    useAuthStore.setState({ gaplessEnabled: true });
    seedQueueResolver('s1', [track('t1'), track('t2', { title: 'Second' })]);
    usePlayerStore.setState({
      currentTrack: track('t1'),
      queueItems: [ref('t1'), ref('t2')],
      queueIndex: 0,
      repeatMode: 'off',
      isPlaying: true,
      currentRadio: null,
    });
  });

  it('catches up UI when engine position regresses without track_switched', () => {
    const beforeAdvance = vi.fn();
    noteEngineProgressForGapless(170);
    expect(maybeReconcileGaplessFromProgress(0.4, 205, beforeAdvance)).toBe(true);

    expect(beforeAdvance).toHaveBeenCalledOnce();
    expect(usePlayerStore.getState().currentTrack?.id).toBe('t2');
    expect(getPlaybackProgressSnapshot().progress).toBe(0);
  });

  it('no-ops when position moves forward normally', () => {
    noteEngineProgressForGapless(10);
    expect(maybeReconcileGaplessFromProgress(11, 200)).toBe(false);

    expect(usePlayerStore.getState().currentTrack?.id).toBe('t1');
  });

  it('no-ops during an active seek guard', () => {
    noteEngineProgressForGapless(100);
    setSeekTarget(20);
    maybeReconcileGaplessFromProgress(0.5, 200);

    expect(usePlayerStore.getState().currentTrack?.id).toBe('t1');
    expect(usePlayerStore.getState().queueIndex).toBe(0);
  });

  it('no-ops on mid-track position regressions (not a gapless boundary)', () => {
    noteEngineProgressForGapless(170);
    maybeReconcileGaplessFromProgress(100, 200);

    expect(usePlayerStore.getState().currentTrack?.id).toBe('t1');
    expect(usePlayerStore.getState().queueIndex).toBe(0);
  });

  it('does not double-advance after track_switched already moved the UI', () => {
    noteEngineProgressForGapless(170);
    applyGaplessQueueAdvance({ engineDurationHint: 210, source: 'track-switched' });
    expect(usePlayerStore.getState().currentTrack?.id).toBe('t2');

    maybeReconcileGaplessFromProgress(2, 210);
    expect(usePlayerStore.getState().currentTrack?.id).toBe('t2');
    expect(usePlayerStore.getState().queueIndex).toBe(1);
  });
});
