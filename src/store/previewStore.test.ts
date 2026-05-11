/**
 * Characterization tests for `previewStore`.
 *
 * Phases F0 (bootstrap, _on* handlers + stopPreview) + F4 (startPreview
 * cross-store reads + failure paths + main-playback volume sync).
 *
 * Drives the store through its public action surface with the real
 * Zustand instance, stubs the Tauri commands via `onInvoke`, and uses
 * `vi.mock('@/api/subsonic')` because `startPreview` calls `buildStreamUrl`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/api/subsonic', () => ({
  savePlayQueue: vi.fn(async () => undefined),
  getPlayQueue: vi.fn(async () => ({ songs: [], current: undefined, position: 0 })),
  buildStreamUrl: vi.fn((id: string) => `https://mock/stream/${id}`),
  buildCoverArtUrl: vi.fn((id: string) => `https://mock/cover/${id}`),
  buildDownloadUrl: vi.fn((id: string) => `https://mock/download/${id}`),
  coverArtCacheKey: vi.fn((id: string, size = 256) => `mock:cover:${id}:${size}`),
  getSong: vi.fn(async () => null),
  getRandomSongs: vi.fn(async () => []),
  getSimilarSongs2: vi.fn(async () => []),
  getTopSongs: vi.fn(async () => []),
  getAlbumInfo2: vi.fn(async () => null),
  reportNowPlaying: vi.fn(async () => undefined),
  scrobbleSong: vi.fn(async () => undefined),
}));

import { usePreviewStore } from './previewStore';
import { useAuthStore } from './authStore';
import { useOrbitStore } from './orbitStore';
import { usePlayerStore } from './playerStore';
import { onInvoke, invokeMock } from '@/test/mocks/tauri';
import { resetAuthStore, resetPreviewStore, resetPlayerStore, resetOrbitStore } from '@/test/helpers/storeReset';

function resetStore() {
  usePreviewStore.setState({
    previewingId: null,
    previewingTrack: null,
    elapsed: 0,
    duration: 30,
    audioStarted: false,
  });
}

describe('previewStore — event handlers', () => {
  beforeEach(resetStore);

  describe('_onStart', () => {
    it('flips audioStarted to true when the id matches the active preview', () => {
      usePreviewStore.setState({
        previewingId: 'song-1',
        previewingTrack: { id: 'song-1', title: 't', artist: 'a' },
      });

      usePreviewStore.getState()._onStart('song-1');

      expect(usePreviewStore.getState().audioStarted).toBe(true);
      expect(usePreviewStore.getState().previewingId).toBe('song-1');
    });

    it('takes over the previewingId when the engine fires start for an unknown id', () => {
      usePreviewStore.setState({ previewingId: null });

      usePreviewStore.getState()._onStart('song-99');

      const state = usePreviewStore.getState();
      expect(state.previewingId).toBe('song-99');
      expect(state.elapsed).toBe(0);
      expect(state.audioStarted).toBe(true);
    });
  });

  describe('_onProgress', () => {
    it('updates elapsed + duration when the id matches', () => {
      usePreviewStore.setState({ previewingId: 'song-1' });

      usePreviewStore.getState()._onProgress('song-1', 12.5, 30);

      const state = usePreviewStore.getState();
      expect(state.elapsed).toBe(12.5);
      expect(state.duration).toBe(30);
    });

    it('ignores progress for a stale id', () => {
      usePreviewStore.setState({ previewingId: 'song-1', elapsed: 5 });

      usePreviewStore.getState()._onProgress('song-stale', 99, 30);

      expect(usePreviewStore.getState().elapsed).toBe(5);
    });
  });

  describe('_onEnd', () => {
    it('clears state when the id matches', () => {
      usePreviewStore.setState({
        previewingId: 'song-1',
        previewingTrack: { id: 'song-1', title: 't', artist: 'a' },
        elapsed: 27,
        audioStarted: true,
      });

      usePreviewStore.getState()._onEnd('song-1');

      const state = usePreviewStore.getState();
      expect(state.previewingId).toBeNull();
      expect(state.previewingTrack).toBeNull();
      expect(state.elapsed).toBe(0);
      expect(state.audioStarted).toBe(false);
    });

    it('ignores end events for a stale id', () => {
      usePreviewStore.setState({ previewingId: 'song-1', elapsed: 5, audioStarted: true });

      usePreviewStore.getState()._onEnd('song-stale');

      expect(usePreviewStore.getState().previewingId).toBe('song-1');
      expect(usePreviewStore.getState().audioStarted).toBe(true);
    });
  });
});

describe('previewStore — stopPreview', () => {
  beforeEach(resetStore);

  it('returns early without invoking when no preview is active', async () => {
    await usePreviewStore.getState().stopPreview();

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('invokes audio_preview_stop when a preview is active', async () => {
    usePreviewStore.setState({ previewingId: 'song-1' });
    onInvoke('audio_preview_stop', () => undefined);

    await usePreviewStore.getState().stopPreview();

    expect(invokeMock).toHaveBeenCalledWith('audio_preview_stop');
  });

  it('falls back to clearing state locally if invoke rejects', async () => {
    usePreviewStore.setState({
      previewingId: 'song-1',
      previewingTrack: { id: 'song-1', title: 't', artist: 'a' },
      audioStarted: true,
    });
    onInvoke('audio_preview_stop', () => {
      throw new Error('engine offline');
    });

    await usePreviewStore.getState().stopPreview();

    const state = usePreviewStore.getState();
    expect(state.previewingId).toBeNull();
    expect(state.previewingTrack).toBeNull();
    expect(state.audioStarted).toBe(false);
  });
});

describe('previewStore — startPreview', () => {
  beforeEach(() => {
    resetPreviewStore();
    resetAuthStore();
    resetOrbitStore();
    resetPlayerStore();
    onInvoke('audio_preview_play', () => undefined);
    onInvoke('audio_preview_stop', () => undefined);
    onInvoke('audio_preview_set_volume', () => undefined);
  });

  const song = (id = 'song-1') => ({
    id,
    title: `Title ${id}`,
    artist: 'Artist',
    coverArt: id,
    duration: 240,
  });

  it('invokes audio_preview_play with the configured args and stores the previewing track', async () => {
    await usePreviewStore.getState().startPreview(song('song-1'), 'suggestions');

    expect(invokeMock).toHaveBeenCalledWith(
      'audio_preview_play',
      expect.objectContaining({
        id: 'song-1',
        url: expect.stringContaining('song-1'),
        durationSec: 30,
        startSec: 240 * 0.33,
      }),
    );

    const state = usePreviewStore.getState();
    expect(state.previewingId).toBe('song-1');
    expect(state.previewingTrack).toEqual({
      id: 'song-1', title: 'Title song-1', artist: 'Artist', coverArt: 'song-1',
    });
    expect(state.elapsed).toBe(0);
    expect(state.audioStarted).toBe(false);
    expect(state.duration).toBe(30);
  });

  it('starts at 0 when the track is too short to need a mid-track seek', async () => {
    // duration <= previewDuration * 1.5 → start at 0.
    await usePreviewStore.getState().startPreview({ ...song(), duration: 30 }, 'suggestions');
    const call = invokeMock.mock.calls.find(c => c[0] === 'audio_preview_play');
    expect(call?.[1]).toEqual(expect.objectContaining({ startSec: 0 }));
  });

  it('passes camelCase keys (Tauri IPC contract — snake_case silently drops to undefined)', async () => {
    await usePreviewStore.getState().startPreview(song(), 'suggestions');
    const call = invokeMock.mock.calls.find(c => c[0] === 'audio_preview_play');
    const args = call?.[1] as Record<string, unknown>;
    expect(args).toHaveProperty('startSec');
    expect(args).toHaveProperty('durationSec');
    expect(args).not.toHaveProperty('start_sec');
    expect(args).not.toHaveProperty('duration_sec');
  });

  it('no-ops when previews are globally disabled', async () => {
    useAuthStore.setState({ trackPreviewsEnabled: false });
    await usePreviewStore.getState().startPreview(song(), 'suggestions');
    expect(invokeMock).not.toHaveBeenCalledWith('audio_preview_play', expect.anything());
    expect(usePreviewStore.getState().previewingId).toBeNull();
  });

  it('no-ops when previews are disabled at the calling location', async () => {
    useAuthStore.setState({
      trackPreviewLocations: {
        suggestions: false,
        albums: true, playlists: true, favorites: true, artist: true, randomMix: true,
      },
    });
    await usePreviewStore.getState().startPreview(song(), 'suggestions');
    expect(invokeMock).not.toHaveBeenCalledWith('audio_preview_play', expect.anything());
  });

  it.each(['active', 'joining', 'starting'] as const)(
    'no-ops while the user is a host inside an Orbit %s phase',
    async (phase) => {
      useOrbitStore.setState({ role: 'host', phase });
      await usePreviewStore.getState().startPreview(song(), 'suggestions');
      expect(invokeMock).not.toHaveBeenCalledWith('audio_preview_play', expect.anything());
    },
  );

  it.each(['active', 'joining', 'starting'] as const)(
    'no-ops while the user is a guest inside an Orbit %s phase',
    async (phase) => {
      useOrbitStore.setState({ role: 'guest', phase });
      await usePreviewStore.getState().startPreview(song(), 'suggestions');
      expect(invokeMock).not.toHaveBeenCalledWith('audio_preview_play', expect.anything());
    },
  );

  it('falls through to startPreview when no orbit session is active (role=null)', async () => {
    useOrbitStore.setState({ role: null, phase: 'idle' });
    await usePreviewStore.getState().startPreview(song(), 'suggestions');
    expect(invokeMock).toHaveBeenCalledWith('audio_preview_play', expect.anything());
  });

  it('treats re-clicking the active preview id as a stop', async () => {
    usePreviewStore.setState({ previewingId: 'song-1' });
    await usePreviewStore.getState().startPreview(song('song-1'), 'suggestions');
    // Goes through stopPreview, not audio_preview_play.
    expect(invokeMock).toHaveBeenCalledWith('audio_preview_stop');
    expect(invokeMock).not.toHaveBeenCalledWith('audio_preview_play', expect.anything());
  });

  it('rolls back optimistic state when the engine invoke rejects', async () => {
    usePreviewStore.setState({
      previewingId: 'older',
      previewingTrack: { id: 'older', title: 'x', artist: 'y' },
      audioStarted: true,
    });
    onInvoke('audio_preview_play', () => {
      throw new Error('engine offline');
    });

    await expect(usePreviewStore.getState().startPreview(song('song-2'), 'suggestions')).rejects.toThrow(/engine offline/);

    // Only rolls back when the rolled-back id is still the optimistic one.
    const state = usePreviewStore.getState();
    expect(state.previewingId).toBeNull();
    expect(state.previewingTrack).toBeNull();
    expect(state.audioStarted).toBe(false);
  });

  it('folds in the loudness pre-attenuation when normalization=loudness', async () => {
    useAuthStore.setState({
      normalizationEngine: 'loudness',
      loudnessPreAnalysisAttenuationDb: -6,
    });
    usePlayerStore.setState({ volume: 1.0 });

    await usePreviewStore.getState().startPreview(song(), 'suggestions');
    const call = invokeMock.mock.calls.find(c => c[0] === 'audio_preview_play');
    const args = call?.[1] as { volume: number };
    // 1.0 * 10^(-6/20) ≈ 0.501 — clamped to [0, 1].
    expect(args.volume).toBeCloseTo(Math.pow(10, -6 / 20), 4);
  });

  it('does NOT fold pre-attenuation when normalizationEngine is off', async () => {
    useAuthStore.setState({ normalizationEngine: 'off' });
    usePlayerStore.setState({ volume: 0.7 });

    await usePreviewStore.getState().startPreview(song(), 'suggestions');
    const call = invokeMock.mock.calls.find(c => c[0] === 'audio_preview_play');
    const args = call?.[1] as { volume: number };
    expect(args.volume).toBeCloseTo(0.7, 5);
  });

  it('does NOT fold a positive pre-attenuation value (Math.min(0, …) guard)', async () => {
    useAuthStore.setState({
      normalizationEngine: 'loudness',
      loudnessPreAnalysisAttenuationDb: 3, // positive — guard pulls to 0
    });
    usePlayerStore.setState({ volume: 0.5 });

    await usePreviewStore.getState().startPreview(song(), 'suggestions');
    const call = invokeMock.mock.calls.find(c => c[0] === 'audio_preview_play');
    const args = call?.[1] as { volume: number };
    expect(args.volume).toBeCloseTo(0.5, 5);
  });
});

describe('previewStore — main-player volume sync during preview', () => {
  beforeEach(() => {
    resetPreviewStore();
    resetAuthStore();
    resetPlayerStore();
    onInvoke('audio_preview_set_volume', () => undefined);
    invokeMock.mockClear();
  });

  it('pings the engine when the main player volume changes mid-preview', () => {
    usePreviewStore.setState({ previewingId: 'song-1' });
    usePlayerStore.setState({ volume: 0.5 });

    usePlayerStore.setState({ volume: 0.8 });

    expect(invokeMock).toHaveBeenCalledWith(
      'audio_preview_set_volume',
      expect.objectContaining({ volume: 0.8 }),
    );
  });

  it('does NOT ping the engine when no preview is active', () => {
    usePreviewStore.setState({ previewingId: null });
    usePlayerStore.setState({ volume: 0.5 });

    usePlayerStore.setState({ volume: 0.8 });

    expect(invokeMock).not.toHaveBeenCalledWith('audio_preview_set_volume', expect.anything());
  });

  it('does NOT ping when the volume value did not actually change', () => {
    usePreviewStore.setState({ previewingId: 'song-1' });
    usePlayerStore.setState({ volume: 0.5 });
    invokeMock.mockClear();

    // Setting to the same value should be skipped by the subscription guard.
    usePlayerStore.setState({ volume: 0.5 });

    expect(invokeMock).not.toHaveBeenCalledWith('audio_preview_set_volume', expect.anything());
  });
});
