import { beforeEach, describe, expect, it, vi } from 'vitest';
import { onInvoke } from '@/test/mocks/tauri';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import {
  _resetQueueResolverForTest,
  seedQueueResolver,
} from '@/features/playback/store/queueTrackResolver';
import * as resolveSongMetaIndexFirst from '@/lib/library/resolveSongMetaIndexFirst';
import {
  _resetIndexRefreshInflightForTest,
  maybeRefreshCurrentTrackMetadataFromIndex,
  maybeSyncCurrentTrackFromResolver,
  shouldSyncCurrentTrackMetadata,
  shouldUpgradeReplayGainMetadata,
  syncIdleAppliesToQueueRef,
} from '@/features/playback/store/replayGainMetadataSync';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';

const ref = (trackId: string): QueueItemRef => ({ serverId: 's1', trackId });

const track = (id: string, extra: Partial<Track> = {}): Track => ({
  id,
  title: extra.title ?? `Track ${id}`,
  artist: 'Artist',
  album: 'Album',
  albumId: extra.albumId ?? 'alb-1',
  duration: 200,
  ...extra,
});

describe('shouldUpgradeReplayGainMetadata', () => {
  beforeEach(() => {
    useAuthStore.setState({
      normalizationEngine: 'replaygain',
      replayGainEnabled: true,
      replayGainMode: 'track',
    });
  });

  it('returns true when track gain appears on a placeholder snapshot', () => {
    const prev = track('t1', { title: '…', replayGainTrackDb: undefined });
    const next = track('t1', { replayGainTrackDb: -8.5 });
    expect(shouldUpgradeReplayGainMetadata(prev, next, [ref('t1')], 0)).toBe(true);
  });

  it('returns false when both snapshots lack ReplayGain tags', () => {
    const prev = track('t1', { replayGainTrackDb: undefined });
    const next = track('t1', { title: 'Resolved title' });
    expect(shouldUpgradeReplayGainMetadata(prev, next, [ref('t1')], 0)).toBe(false);
  });

  it('returns true when peak metadata arrives', () => {
    const base = track('t1', { replayGainTrackDb: -6 });
    const withPeak = { ...base, replayGainPeak: 0.98 };
    expect(shouldUpgradeReplayGainMetadata(base, withPeak, [ref('t1')], 0)).toBe(true);
  });

  it('returns true when track gain was recalculated on the server', () => {
    const prev = track('t1', { replayGainTrackDb: -6.0 });
    const next = track('t1', { replayGainTrackDb: -8.5 });
    expect(shouldUpgradeReplayGainMetadata(prev, next, [ref('t1')], 0)).toBe(true);
  });
});

describe('shouldSyncCurrentTrackMetadata', () => {
  it('returns true when placeholder title resolves', () => {
    const prev = track('t1', { title: '…' });
    const next = track('t1', { title: 'Resolved title' });
    expect(shouldSyncCurrentTrackMetadata(prev, next, [ref('t1')], 0)).toBe(true);
  });

  it('returns true when duration arrives on a thin snapshot', () => {
    const prev = track('t1', { duration: 0 });
    const next = track('t1', { duration: 240 });
    expect(shouldSyncCurrentTrackMetadata(prev, next, [ref('t1')], 0)).toBe(true);
  });
});

describe('maybeSyncCurrentTrackFromResolver', () => {
  beforeEach(() => {
    _resetQueueResolverForTest();
    onInvoke('audio_update_replay_gain', () => undefined);
    useAuthStore.setState({
      normalizationEngine: 'replaygain',
      replayGainEnabled: true,
      replayGainMode: 'track',
      replayGainPreGainDb: 0,
      replayGainFallbackDb: -6,
    });
    usePlayerStore.setState({
      currentTrack: track('t1', { title: '…' }),
      queueItems: [ref('t1')],
      queueIndex: 0,
      isPlaying: true,
      currentRadio: null,
      volume: 0.8,
    });
    vi.clearAllMocks();
  });

  it('upgrades currentTrack and pushes replay gain when the resolver cache fills', () => {
    seedQueueResolver('s1', [track('t1', { replayGainTrackDb: -7.2, replayGainPeak: 0.95 })]);

    maybeSyncCurrentTrackFromResolver();

    const s = usePlayerStore.getState();
    expect(s.currentTrack?.replayGainTrackDb).toBe(-7.2);
    expect(s.currentTrack?.replayGainPeak).toBe(0.95);
  });

  it('no-ops engine gain when ReplayGain mode is off but still syncs thin title', () => {
    useAuthStore.setState({ normalizationEngine: 'off', replayGainEnabled: false });
    seedQueueResolver('s1', [track('t1', { title: 'Full title' })]);

    maybeSyncCurrentTrackFromResolver();

    expect(usePlayerStore.getState().currentTrack?.title).toBe('Full title');
    expect(usePlayerStore.getState().currentTrack?.replayGainTrackDb).toBeUndefined();
  });

  it('no-ops when transport is idle', () => {
    usePlayerStore.setState({ isPlaying: false });
    seedQueueResolver('s1', [track('t1', { title: 'Full title', duration: 220 })]);

    maybeSyncCurrentTrackFromResolver();

    expect(usePlayerStore.getState().currentTrack?.title).toBe('…');
  });

  it('upgrades placeholder title without ReplayGain when normalization is off', () => {
    useAuthStore.setState({ normalizationEngine: 'off', replayGainEnabled: false });
    seedQueueResolver('s1', [track('t1', { title: 'Full title', duration: 220 })]);

    maybeSyncCurrentTrackFromResolver();

    const s = usePlayerStore.getState();
    expect(s.currentTrack?.title).toBe('Full title');
    expect(s.currentTrack?.duration).toBe(220);
  });

  it('syncs ReplayGain tags from the resolver onto the live track', () => {
    seedQueueResolver('s1', [track('t1', { replayGainTrackDb: -7.2, replayGainPeak: 0.95 })]);

    maybeSyncCurrentTrackFromResolver();

    expect(usePlayerStore.getState().currentTrack?.replayGainTrackDb).toBe(-7.2);
  });
});

describe('maybeRefreshCurrentTrackMetadataFromIndex', () => {
  beforeEach(() => {
    _resetQueueResolverForTest();
    _resetIndexRefreshInflightForTest();
    vi.restoreAllMocks();
    onInvoke('audio_update_replay_gain', () => undefined);
    useAuthStore.setState({
      normalizationEngine: 'replaygain',
      replayGainEnabled: true,
      replayGainMode: 'track',
      replayGainPreGainDb: 0,
      replayGainFallbackDb: -6,
    });
    useLibraryIndexStore.setState({ masterEnabled: true });
    usePlayerStore.setState({
      currentTrack: track('t1', { replayGainTrackDb: -6.0, replayGainPeak: 0.8 }),
      queueItems: [ref('t1')],
      queueIndex: 0,
      isPlaying: true,
      currentRadio: null,
      volume: 0.8,
    });
  });

  it('upgrades recalculated ReplayGain from the library index', async () => {
    onInvoke('library_get_status', () => ({
      serverId: 's1', libraryScope: '', syncPhase: 'ready',
      capabilityFlags: 0, libraryTier: 'unknown', syncedAt: 0,
    }));
    onInvoke('library_get_track', () => ({
      serverId: 's1',
      id: 't1',
      title: 'Track t1',
      album: 'Album',
      durationSec: 200,
      replayGainTrackDb: -8.5,
      replayGainPeak: 0.91,
      syncedAt: 0,
      rawJson: {},
    }));

    await maybeRefreshCurrentTrackMetadataFromIndex();

    const s = usePlayerStore.getState();
    expect(s.currentTrack?.replayGainTrackDb).toBe(-8.5);
    expect(s.currentTrack?.replayGainPeak).toBe(0.91);
  });

  it('no-ops when the playing slot changed during index fetch', async () => {
    vi.spyOn(resolveSongMetaIndexFirst, 'resolveSongMetaIndexFirst').mockImplementation(async () => {
      usePlayerStore.setState({
        currentTrack: track('t2', { replayGainTrackDb: -3.0 }),
        queueItems: [ref('t1'), ref('t2')],
        queueIndex: 1,
      });
      return {
        id: 't1',
        title: 'Track t1',
        album: 'Album',
        duration: 200,
        replayGain: { trackGain: -8.5, trackPeak: 0.91 },
      } as Awaited<ReturnType<typeof resolveSongMetaIndexFirst.resolveSongMetaIndexFirst>>;
    });

    await maybeRefreshCurrentTrackMetadataFromIndex();

    const s = usePlayerStore.getState();
    expect(s.currentTrack?.id).toBe('t2');
    expect(s.currentTrack?.replayGainTrackDb).toBe(-3.0);
  });
});

describe('syncIdleAppliesToQueueRef', () => {
  it('matches profile id to index key on the ref', () => {
    expect(syncIdleAppliesToQueueRef('profile-uuid', { serverId: 'profile-uuid', trackId: 't1' }))
      .toBe(true);
  });
});
