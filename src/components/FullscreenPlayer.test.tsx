/**
 * `FullscreenPlayer` characterization (Phase F5c).
 *
 * Includes the §4.5 regression test from the v2 plan — the cover image
 * must call `useCachedUrl(coverUrl, coverKey, false)`. The `false`
 * third argument selects the fallback path that avoids a double
 * crossfade (fetchUrl → blobUrl). A refactor that "tidies up" the
 * useCachedUrl call sites would silently regress the FS player.
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
  star: vi.fn(async () => undefined),
  unstar: vi.fn(async () => undefined),
  getLyricsBySongId: vi.fn(async () => null),
}));

vi.mock('@/api/lastfm', () => ({
  lastfmScrobble: vi.fn(async () => undefined),
  lastfmUpdateNowPlaying: vi.fn(async () => undefined),
  lastfmLoveTrack: vi.fn(async () => undefined),
  lastfmUnloveTrack: vi.fn(async () => undefined),
  lastfmGetTrackLoved: vi.fn(async () => false),
  lastfmGetAllLovedTracks: vi.fn(async () => []),
}));

// `useCachedUrl` is the surface §4.5 needs to characterize. Mock the module
// so we can assert the third positional arg `false` is preserved.
vi.mock('./CachedImage', async () => {
  const actual = await vi.importActual<typeof import('./CachedImage')>('./CachedImage');
  return {
    ...actual,
    useCachedUrl: vi.fn((url, _key, opt) => `mock://${url}?opt=${String(opt ?? 'default')}`),
  };
});

import FullscreenPlayer from './FullscreenPlayer';
import { useCachedUrl } from './CachedImage';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { usePlayerStore } from '@/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { makeTrack, seedQueue } from '@/test/helpers/factories';
import { onInvoke, registerDefaultCoverInvokeHandlers } from '@/test/mocks/tauri';
import { fireEvent } from '@testing-library/react';

beforeEach(() => {
  resetAllStores();
  const id = useAuthStore.getState().addServer({
    name: 'T', url: 'https://x.test', username: 'u', password: 'p',
  });
  useAuthStore.getState().setActiveServer(id);
  vi.mocked(useCachedUrl).mockClear();
  registerDefaultCoverInvokeHandlers();
  onInvoke('audio_play', () => undefined);
  onInvoke('audio_pause', () => undefined);
  onInvoke('audio_stop', () => undefined);
  onInvoke('audio_seek', () => undefined);
  onInvoke('audio_get_state', () => ({ playing: false }));
  onInvoke('audio_update_replay_gain', () => undefined);
  onInvoke('discord_update_presence', () => undefined);
});

afterEach(() => {
  vi.mocked(useCachedUrl).mockClear();
});

describe('FullscreenPlayer — render', () => {
  it('renders the labelled Fullscreen Player dialog', () => {
    usePlayerStore.setState({ currentTrack: makeTrack({ coverArt: 'art-1' }) });
    const { getByLabelText } = renderWithProviders(
      <FullscreenPlayer onClose={() => {}} />,
    );
    expect(getByLabelText('Fullscreen Player')).toBeInTheDocument();
  });

  it('exposes the Close Fullscreen button', () => {
    usePlayerStore.setState({ currentTrack: makeTrack() });
    const { getByLabelText } = renderWithProviders(
      <FullscreenPlayer onClose={() => {}} />,
    );
    expect(getByLabelText('Close Fullscreen')).toBeInTheDocument();
  });
});

describe('FullscreenPlayer — regression §4.5 of v2 plan', () => {
  // The component calls `useCachedUrl` twice:
  //   - line 338: for the small art box (default behaviour, opt=true)
  //   - line 674: for the cover (opt=false, no fetchUrl fallback)
  // The `false` arg is load-bearing — it avoids a double crossfade by
  // routing through the cache-only path. Pin it.
  it('passes opt=false on the cover-art useCachedUrl call (no fetchUrl fallback)', () => {
    usePlayerStore.setState({ currentTrack: makeTrack({ coverArt: 'art-1' }) });
    renderWithProviders(<FullscreenPlayer onClose={() => {}} />);

    const calls = vi.mocked(useCachedUrl).mock.calls;
    // Find the call whose cacheKey targets the 500 px cover (`...:cover:art-1:500`).
    const coverCall = calls.find(c => c[2] === false);
    expect(coverCall).toBeDefined();
    expect(typeof coverCall?.[1]).toBe('string');
    expect(String(coverCall?.[1])).toContain('art-1');
  });

  it('also issues a useCachedUrl call with the default behaviour for the small art box', () => {
    usePlayerStore.setState({ currentTrack: makeTrack({ coverArt: 'art-1' }) });
    renderWithProviders(<FullscreenPlayer onClose={() => {}} />);

    const calls = vi.mocked(useCachedUrl).mock.calls;
    const defaultOptCalls = calls.filter(c => c[2] !== false);
    expect(defaultOptCalls.length).toBeGreaterThanOrEqual(1);
    expect(defaultOptCalls.some(c => String(c[1]).includes('art-1'))).toBe(true);
  });
});

describe('FullscreenPlayer — control wiring', () => {
  it('clicking Close Fullscreen calls the onClose prop', () => {
    usePlayerStore.setState({ currentTrack: makeTrack() });
    const onClose = vi.fn();
    const { getByLabelText } = renderWithProviders(
      <FullscreenPlayer onClose={onClose} />,
    );
    fireEvent.click(getByLabelText('Close Fullscreen'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking Stop calls stop()', () => {
    usePlayerStore.setState({ currentTrack: makeTrack() });
    const stopSpy = vi.spyOn(usePlayerStore.getState(), 'stop');
    const { getByLabelText } = renderWithProviders(
      <FullscreenPlayer onClose={() => {}} />,
    );
    fireEvent.click(getByLabelText('Stop'));
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('clicking Previous Track calls previous()', () => {
    seedQueue([makeTrack({ id: 'a' }), makeTrack({ id: 'b' })], {
      index: 1,
      currentTrack: makeTrack({ id: 'b' }),
    });
    usePlayerStore.setState({ currentTime: 5 });
    const prevSpy = vi.spyOn(usePlayerStore.getState(), 'previous');
    const { getByLabelText } = renderWithProviders(
      <FullscreenPlayer onClose={() => {}} />,
    );
    fireEvent.click(getByLabelText('Previous Track'));
    expect(prevSpy).toHaveBeenCalledTimes(1);
  });

  it('clicking Next Track calls next()', () => {
    seedQueue([makeTrack({ id: 'a' }), makeTrack({ id: 'b' })], {
      index: 0,
      currentTrack: makeTrack({ id: 'a' }),
    });
    const nextSpy = vi.spyOn(usePlayerStore.getState(), 'next');
    const { getByLabelText } = renderWithProviders(
      <FullscreenPlayer onClose={() => {}} />,
    );
    fireEvent.click(getByLabelText('Next Track'));
    expect(nextSpy).toHaveBeenCalledTimes(1);
  });

  it('clicking Repeat cycles via toggleRepeat', () => {
    usePlayerStore.setState({ currentTrack: makeTrack() });
    const { getByLabelText } = renderWithProviders(
      <FullscreenPlayer onClose={() => {}} />,
    );
    expect(usePlayerStore.getState().repeatMode).toBe('off');
    fireEvent.click(getByLabelText('Repeat'));
    expect(usePlayerStore.getState().repeatMode).toBe('all');
  });
});
