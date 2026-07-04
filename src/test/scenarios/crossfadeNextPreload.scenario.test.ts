import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { maybeCrossfadeBytePreload } from '@/features/playback/store/crossfadePreload';
import { _resetGaplessPreloadStateForTest } from '@/features/playback/store/gaplessPreloadState';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { makeTracks, seedQueue } from '@/test/helpers/factories';
import { resetAllStores } from '@/test/helpers/storeReset';
import { invokeMock, onInvoke } from '@/test/mocks/tauri';

// Scenario: crossfade on/off × next / queue end. `maybeCrossfadeBytePreload` is the
// content-driven pre-buffer: with crossfade on and the current track inside the
// pre-buffer window it eagerly byte-preloads the NEXT track (so the fade has bytes);
// with crossfade off it is a hard cut (no preload); gapless owns its own pre-buffer;
// repeat-one and a true queue end (repeat off) preload nothing. Observable = whether
// `audio_preload` fires and for which track.

// dur 180 s, window = crossfadeSecs(3) + trim(0) + BUDGET(30) = 33 s; 170 s in → within.
const DUR = 180;
const NEAR_END = 170;

function preloadCalls(): Array<{ analysisTrackId: string }> {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === 'audio_preload')
    .map(([, args]) => args as { analysisTrackId: string });
}

function setCrossfade(opts: Partial<{ crossfadeEnabled: boolean; gaplessEnabled: boolean }>): void {
  useAuthStore.setState({ crossfadeEnabled: true, gaplessEnabled: false, ...opts });
}

beforeEach(() => {
  resetAllStores();
  _resetGaplessPreloadStateForTest();
  onInvoke('audio_preload', () => undefined);
  // Neighbour loudness prefetch (fire-and-forget) — keep it a no-op miss.
  onInvoke('analysis_get_loudness_for_track', () => null);
});

describe('crossfade on/off × next / queue end', () => {
  it('crossfade on + inside the window → eager preload of the next track', () => {
    const tracks = makeTracks(2);
    seedQueue(tracks, { index: 0 });
    setCrossfade({ crossfadeEnabled: true });
    maybeCrossfadeBytePreload(NEAR_END, DUR);
    expect(preloadCalls().map(c => c.analysisTrackId)).toEqual([tracks[1].id]);
  });

  it('crossfade off → hard cut, no preload', () => {
    seedQueue(makeTracks(2), { index: 0 });
    setCrossfade({ crossfadeEnabled: false });
    maybeCrossfadeBytePreload(NEAR_END, DUR);
    expect(preloadCalls()).toHaveLength(0);
  });

  it('gapless owns pre-buffer → crossfade preload is a no-op', () => {
    seedQueue(makeTracks(2), { index: 0 });
    setCrossfade({ crossfadeEnabled: true, gaplessEnabled: true });
    maybeCrossfadeBytePreload(NEAR_END, DUR);
    expect(preloadCalls()).toHaveLength(0);
  });

  it('outside the pre-buffer window (early in the track) → no preload yet', () => {
    seedQueue(makeTracks(2), { index: 0 });
    setCrossfade({ crossfadeEnabled: true });
    maybeCrossfadeBytePreload(10, DUR); // remaining 170 s ≫ 33 s window
    expect(preloadCalls()).toHaveLength(0);
  });

  it('repeat-one → no next track to preload', () => {
    seedQueue(makeTracks(2), { index: 0 });
    setCrossfade({ crossfadeEnabled: true });
    usePlayerStore.setState({ repeatMode: 'one' });
    maybeCrossfadeBytePreload(NEAR_END, DUR);
    expect(preloadCalls()).toHaveLength(0);
  });

  it('queue end + repeat off → clean stop, no preload', () => {
    const tracks = makeTracks(2);
    seedQueue(tracks, { index: 1 }); // on the last item
    setCrossfade({ crossfadeEnabled: true });
    usePlayerStore.setState({ repeatMode: 'off' });
    maybeCrossfadeBytePreload(NEAR_END, DUR);
    expect(preloadCalls()).toHaveLength(0);
  });

  it('queue end + repeat all → wraps and preloads the first track', () => {
    const tracks = makeTracks(2);
    seedQueue(tracks, { index: 1 });
    setCrossfade({ crossfadeEnabled: true });
    usePlayerStore.setState({ repeatMode: 'all' });
    maybeCrossfadeBytePreload(NEAR_END, DUR);
    expect(preloadCalls().map(c => c.analysisTrackId)).toEqual([tracks[0].id]);
  });
});
