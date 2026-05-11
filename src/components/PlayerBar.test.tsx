/**
 * `PlayerBar` characterization (Phase F5b).
 *
 * Asserts on the public control wiring (play/pause/next/prev/repeat/stop)
 * and the no-track empty state. Visual / hover / overflow logic lives in
 * the manual smoke list — jsdom doesn't compute layout.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  lastfmLoveTrack: vi.fn(async () => undefined),
  lastfmUnloveTrack: vi.fn(async () => undefined),
  lastfmGetTrackLoved: vi.fn(async () => false),
  lastfmGetAllLovedTracks: vi.fn(async () => []),
}));

import PlayerBar from './PlayerBar';
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
  const id = useAuthStore.getState().addServer({
    name: 'T', url: 'https://x.test', username: 'u', password: 'p',
  });
  useAuthStore.getState().setActiveServer(id);
  onInvoke('audio_play', () => undefined);
  onInvoke('audio_pause', () => undefined);
  onInvoke('audio_resume', () => undefined);
  onInvoke('audio_stop', () => undefined);
  onInvoke('audio_seek', () => undefined);
  onInvoke('audio_get_state', () => ({ playing: false }));
  onInvoke('audio_update_replay_gain', () => undefined);
  onInvoke('discord_update_presence', () => undefined);
});

describe('PlayerBar — render', () => {
  it('renders the player region with the labelled landmark', () => {
    const { getByLabelText } = renderWithProviders(<PlayerBar />);
    expect(getByLabelText('Music Player')).toBeInTheDocument();
  });

  it('exposes Previous Track / Play / Next Track / Repeat / Stop controls when a track is loaded', () => {
    const track = makeTrack();
    usePlayerStore.setState({ currentTrack: track, isPlaying: false });
    const { getByLabelText } = renderWithProviders(<PlayerBar />);
    expect(getByLabelText('Previous Track')).toBeInTheDocument();
    expect(getByLabelText('Play')).toBeInTheDocument();
    expect(getByLabelText('Next Track')).toBeInTheDocument();
    expect(getByLabelText('Repeat')).toBeInTheDocument();
    expect(getByLabelText('Stop')).toBeInTheDocument();
  });

  it('the middle control reads "Pause" while playback is active', () => {
    usePlayerStore.setState({ currentTrack: makeTrack(), isPlaying: true });
    const { getByLabelText } = renderWithProviders(<PlayerBar />);
    expect(getByLabelText('Pause')).toBeInTheDocument();
  });
});

describe('PlayerBar — control wiring', () => {
  it('clicking the Play/Pause button calls togglePlay', () => {
    const track = makeTrack();
    usePlayerStore.setState({ currentTrack: track, isPlaying: false });
    const toggleSpy = vi.spyOn(usePlayerStore.getState(), 'togglePlay');

    const { getByLabelText } = renderWithProviders(<PlayerBar />);
    fireEvent.click(getByLabelText('Play'));

    expect(toggleSpy).toHaveBeenCalledTimes(1);
  });

  it('clicking Previous Track calls previous()', () => {
    usePlayerStore.setState({
      queue: [makeTrack({ id: 'a' }), makeTrack({ id: 'b' })],
      queueIndex: 1,
      currentTrack: makeTrack({ id: 'b' }),
      currentTime: 10, // > 3 s → restart current
    });
    const prevSpy = vi.spyOn(usePlayerStore.getState(), 'previous');

    const { getByLabelText } = renderWithProviders(<PlayerBar />);
    fireEvent.click(getByLabelText('Previous Track'));

    expect(prevSpy).toHaveBeenCalledTimes(1);
  });

  it('clicking Next Track calls next()', () => {
    const t1 = makeTrack({ id: 'a' });
    const t2 = makeTrack({ id: 'b' });
    usePlayerStore.setState({ queue: [t1, t2], queueIndex: 0, currentTrack: t1 });
    const nextSpy = vi.spyOn(usePlayerStore.getState(), 'next');

    const { getByLabelText } = renderWithProviders(<PlayerBar />);
    fireEvent.click(getByLabelText('Next Track'));

    expect(nextSpy).toHaveBeenCalledTimes(1);
  });

  it('clicking Repeat cycles through off → all → one', () => {
    usePlayerStore.setState({ currentTrack: makeTrack() });
    const { getByLabelText, rerender } = renderWithProviders(<PlayerBar />);

    expect(usePlayerStore.getState().repeatMode).toBe('off');
    fireEvent.click(getByLabelText('Repeat'));
    expect(usePlayerStore.getState().repeatMode).toBe('all');

    rerender(<PlayerBar />);
    fireEvent.click(getByLabelText('Repeat'));
    expect(usePlayerStore.getState().repeatMode).toBe('one');
  });

  it('clicking Stop calls stop()', () => {
    usePlayerStore.setState({ currentTrack: makeTrack(), isPlaying: true });
    const stopSpy = vi.spyOn(usePlayerStore.getState(), 'stop');

    const { getByLabelText } = renderWithProviders(<PlayerBar />);
    fireEvent.click(getByLabelText('Stop'));

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});

describe('PlayerBar — empty state (no current track)', () => {
  it('still renders the region landmark when no track is loaded', () => {
    usePlayerStore.setState({ currentTrack: null, isPlaying: false });
    const { getByLabelText } = renderWithProviders(<PlayerBar />);
    expect(getByLabelText('Music Player')).toBeInTheDocument();
  });
});
