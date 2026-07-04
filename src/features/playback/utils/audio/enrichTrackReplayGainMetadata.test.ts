import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as subsonicLibrary from '@/lib/api/subsonicLibrary';
import { onInvoke } from '@/test/mocks/tauri';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import type { Track } from '@/lib/media/trackTypes';
import {
  enrichTrackPlaybackMetadata,
  mergePlaybackTrackMetadata,
  trackNeedsPlaybackMetadataPrefetch,
  trackNeedsReplayGainMetadataPrefetch,
} from '@/features/playback/utils/audio/enrichTrackReplayGainMetadata';

const track = (extra: Partial<Track> = {}): Track => ({
  id: 't1',
  title: extra.title ?? 'Track',
  artist: 'Artist',
  album: 'Album',
  albumId: 'alb-1',
  duration: 200,
  ...extra,
});

describe('trackNeedsReplayGainMetadataPrefetch', () => {
  beforeEach(() => {
    useAuthStore.setState({
      normalizationEngine: 'replaygain',
      replayGainEnabled: true,
    });
  });

  it('returns true when ReplayGain is on and tags are missing', () => {
    expect(trackNeedsReplayGainMetadataPrefetch(track())).toBe(true);
  });

  it('returns false when track gain is present', () => {
    expect(trackNeedsReplayGainMetadataPrefetch(track({ replayGainTrackDb: -6 }))).toBe(false);
  });
});

describe('mergePlaybackTrackMetadata', () => {
  it('fills placeholder title and ReplayGain from the resolved track', () => {
    const base = track({ title: '…', duration: 0 });
    const resolved = track({
      title: 'Resolved',
      duration: 240,
      replayGainTrackDb: -7.5,
      replayGainPeak: 0.99,
    });
    const merged = mergePlaybackTrackMetadata(base, resolved);
    expect(merged.title).toBe('Resolved');
    expect(merged.duration).toBe(240);
    expect(merged.replayGainTrackDb).toBe(-7.5);
    expect(merged.replayGainPeak).toBe(0.99);
  });
});

describe('trackNeedsPlaybackMetadataPrefetch', () => {
  beforeEach(() => {
    useAuthStore.setState({
      normalizationEngine: 'off',
      replayGainEnabled: false,
    });
  });

  it('returns true for thin placeholder snapshots even when ReplayGain is off', () => {
    expect(trackNeedsPlaybackMetadataPrefetch(track({ title: '…' }))).toBe(true);
    expect(trackNeedsPlaybackMetadataPrefetch(track({ duration: 0 }))).toBe(true);
  });

  it('returns true when ReplayGain is on and peak is missing but gain tags exist', () => {
    useAuthStore.setState({
      normalizationEngine: 'replaygain',
      replayGainEnabled: true,
    });
    expect(trackNeedsPlaybackMetadataPrefetch(track({ replayGainTrackDb: -6 }))).toBe(true);
  });

  it('returns false when ReplayGain tags and peak are present', () => {
    useAuthStore.setState({
      normalizationEngine: 'replaygain',
      replayGainEnabled: true,
    });
    expect(trackNeedsPlaybackMetadataPrefetch(track({
      replayGainTrackDb: -6,
      replayGainPeak: 0.88,
    }))).toBe(false);
  });
});

describe('enrichTrackPlaybackMetadata', () => {
  beforeEach(() => {
    useAuthStore.setState({
      normalizationEngine: 'replaygain',
      replayGainEnabled: true,
    });
    useLibraryIndexStore.setState({ masterEnabled: true });
    vi.restoreAllMocks();
  });

  it('reads ReplayGain from the local index before network', async () => {
    onInvoke('library_get_status', () => ({
      serverId: 's1', libraryScope: '', syncPhase: 'ready',
      capabilityFlags: 0, libraryTier: 'unknown', syncedAt: 0,
    }));
    onInvoke('library_get_track', () => ({
      serverId: 's1',
      id: 't1',
      title: 'Indexed',
      album: 'Album',
      durationSec: 200,
      replayGainTrackDb: -8.1,
      replayGainAlbumDb: -7.0,
      syncedAt: 0,
      rawJson: {},
    }));
    const networkSpy = vi.spyOn(subsonicLibrary, 'getSongForServer');

    const enriched = await enrichTrackPlaybackMetadata(track({ title: '…' }), 's1');
    expect(enriched.replayGainTrackDb).toBe(-8.1);
    expect(enriched.title).toBe('Indexed');
    expect(networkSpy).not.toHaveBeenCalled();
  });

  it('reads replayGainPeak from the local index without network', async () => {
    onInvoke('library_get_status', () => ({
      serverId: 's1', libraryScope: '', syncPhase: 'ready',
      capabilityFlags: 0, libraryTier: 'unknown', syncedAt: 0,
    }));
    onInvoke('library_get_track', () => ({
      serverId: 's1',
      id: 't1',
      title: 'Indexed',
      album: 'Album',
      durationSec: 200,
      replayGainTrackDb: -8.1,
      replayGainPeak: 0.88,
      syncedAt: 0,
      rawJson: {},
    }));
    const networkSpy = vi.spyOn(subsonicLibrary, 'getSongForServer');

    const enriched = await enrichTrackPlaybackMetadata(
      track({ replayGainTrackDb: -8.1 }),
      's1',
    );
    expect(enriched.replayGainPeak).toBe(0.88);
    expect(networkSpy).not.toHaveBeenCalled();
  });

  it('refreshes recalculated ReplayGain from the index when tags already exist', async () => {
    onInvoke('library_get_status', () => ({
      serverId: 's1', libraryScope: '', syncPhase: 'ready',
      capabilityFlags: 0, libraryTier: 'unknown', syncedAt: 0,
    }));
    onInvoke('library_get_track', () => ({
      serverId: 's1',
      id: 't1',
      title: 'Indexed',
      album: 'Album',
      durationSec: 200,
      replayGainTrackDb: -8.5,
      replayGainPeak: 0.91,
      syncedAt: 0,
      rawJson: {},
    }));

    const enriched = await enrichTrackPlaybackMetadata(
      track({ replayGainTrackDb: -6.0, replayGainPeak: 0.8 }),
      's1',
    );
    expect(enriched.replayGainTrackDb).toBe(-8.5);
    expect(enriched.replayGainPeak).toBe(0.91);
  });
});
