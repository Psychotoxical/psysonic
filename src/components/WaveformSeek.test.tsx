/**
 * `WaveformSeek` characterization (Phase F5a).
 *
 * jsdom does not run canvas rendering, so this file tests the input
 * surface (cursor state, no-track guard, wheel-debounce → seek wiring)
 * rather than the visual output. The actual canvas drawing path is
 * covered by manual smoke per the v2 plan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@/api/lastfm', () => ({
  lastfmScrobble: vi.fn(async () => undefined),
  lastfmUpdateNowPlaying: vi.fn(async () => undefined),
  lastfmGetTrackLoved: vi.fn(async () => false),
  lastfmGetAllLovedTracks: vi.fn(async () => []),
}));

import WaveformSeek from './WaveformSeek';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { usePlayerStore } from '@/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { makeTrack } from '@/test/helpers/factories';
import { onInvoke } from '@/test/mocks/tauri';
import { fireEvent } from '@testing-library/react';

beforeEach(() => {
  vi.useFakeTimers();
  resetAllStores();
  // Seed an active server so any downstream invokes are valid.
  const id = useAuthStore.getState().addServer({
    name: 'T', url: 'https://x.test', username: 'u', password: 'p',
  });
  useAuthStore.getState().setActiveServer(id);
  onInvoke('audio_play', () => undefined);
  onInvoke('audio_pause', () => undefined);
  onInvoke('audio_seek', () => undefined);
  onInvoke('audio_get_state', () => ({ playing: false }));
  onInvoke('audio_update_replay_gain', () => undefined);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('WaveformSeek — render surface', () => {
  it('renders a canvas element', () => {
    const { container } = renderWithProviders(<WaveformSeek trackId="t1" />);
    expect(container.querySelector('canvas')).not.toBeNull();
  });

  it('canvas cursor is "default" when trackId is undefined (no track loaded)', () => {
    const { container } = renderWithProviders(<WaveformSeek trackId={undefined} />);
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.style.cursor).toBe('default');
  });

  it('canvas cursor is "pointer" when a trackId is present (seekable)', () => {
    const { container } = renderWithProviders(<WaveformSeek trackId="t1" />);
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.style.cursor).toBe('pointer');
  });
});

describe('WaveformSeek — guards before seek', () => {
  it('does not call seek when wheeled without a trackId', () => {
    const seekSpy = vi.spyOn(usePlayerStore.getState(), 'seek');
    const { container } = renderWithProviders(<WaveformSeek trackId={undefined} />);
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;

    fireEvent.wheel(canvas, { deltaY: -100 });
    vi.advanceTimersByTime(1000);

    expect(seekSpy).not.toHaveBeenCalled();
  });

  it('does not call seek when wheeled without a current track in the store (duration = 0)', () => {
    const seekSpy = vi.spyOn(usePlayerStore.getState(), 'seek');
    // trackId is set but the store currentTrack is null → duration = 0 → guard fires.
    const { container } = renderWithProviders(<WaveformSeek trackId="t1" />);
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;

    fireEvent.wheel(canvas, { deltaY: -100 });
    vi.advanceTimersByTime(1000);

    expect(seekSpy).not.toHaveBeenCalled();
  });
});

describe('WaveformSeek — wheel-to-seek wiring', () => {
  it('commits the seek through a 350 ms trailing debounce', () => {
    const track = makeTrack({ id: 't1', duration: 200 });
    usePlayerStore.setState({ currentTrack: track, isPlaying: true });
    const seekSpy = vi.spyOn(usePlayerStore.getState(), 'seek');

    const { container } = renderWithProviders(<WaveformSeek trackId="t1" />);
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;

    fireEvent.wheel(canvas, { deltaY: -120 });
    // Seek not yet committed — still inside the 350 ms debounce.
    expect(seekSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(400);
    expect(seekSpy).toHaveBeenCalledTimes(1);
    const fraction = seekSpy.mock.calls[0]?.[0] as number;
    expect(fraction).toBeGreaterThanOrEqual(0);
    expect(fraction).toBeLessThanOrEqual(1);
  });

  it('coalesces rapid wheel events when each fires within the debounce window', () => {
    const track = makeTrack({ id: 't1', duration: 200 });
    usePlayerStore.setState({ currentTrack: track });
    const seekSpy = vi.spyOn(usePlayerStore.getState(), 'seek');

    const { container } = renderWithProviders(<WaveformSeek trackId="t1" />);
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;

    // Three wheels in quick succession (all within 350 ms of each other).
    fireEvent.wheel(canvas, { deltaY: -100 });
    fireEvent.wheel(canvas, { deltaY: -100 });
    fireEvent.wheel(canvas, { deltaY: -100 });
    vi.advanceTimersByTime(400);

    // Far fewer commits than wheel events — coalescing reduces engine load.
    expect(seekSpy.mock.calls.length).toBeLessThan(3);
    expect(seekSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('WaveformSeek — listener lifecycle', () => {
  it('mount + unmount completes without throwing', () => {
    const { unmount } = renderWithProviders(<WaveformSeek trackId="t1" />);
    expect(() => unmount()).not.toThrow();
  });
});
