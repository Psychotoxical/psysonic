import { beforeEach, describe, expect, it } from 'vitest';
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
    noteEngineProgressForGapless(170);
    maybeReconcileGaplessFromProgress(0.4, 205);

    expect(usePlayerStore.getState().currentTrack?.id).toBe('t2');
    expect(getPlaybackProgressSnapshot().progress).toBe(0);
  });

  it('no-ops when position moves forward normally', () => {
    noteEngineProgressForGapless(10);
    maybeReconcileGaplessFromProgress(11, 200);

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
