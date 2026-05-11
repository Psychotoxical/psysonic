/**
 * `MiniPlayer` characterization (Phase F5c).
 *
 * Per pick 4a of the v2 plan: renders + click handlers only. The
 * cross-webview bridge contract (`mini:ready` / `mini:sync` emit-listen,
 * geometry persistence) is covered separately in B-tier phase B5; jsdom
 * does not model two webviews, so an in-process test would only fake
 * what we're trying to verify.
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
  lastfmGetTrackLoved: vi.fn(async () => false),
  lastfmGetAllLovedTracks: vi.fn(async () => []),
}));

import MiniPlayer from './MiniPlayer';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { useAuthStore } from '@/store/authStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { onInvoke } from '@/test/mocks/tauri';
import { fireEvent } from '@testing-library/react';

beforeEach(() => {
  resetAllStores();
  const id = useAuthStore.getState().addServer({
    name: 'T', url: 'https://x.test', username: 'u', password: 'p',
  });
  useAuthStore.getState().setActiveServer(id);
  onInvoke('audio_play', () => undefined);
  onInvoke('audio_pause', () => undefined);
  onInvoke('audio_seek', () => undefined);
  onInvoke('audio_stop', () => undefined);
  onInvoke('audio_get_state', () => ({ playing: false }));
  onInvoke('set_window_always_on_top', () => undefined);
  onInvoke('set_linux_webkit_smooth_scrolling', () => undefined);
  onInvoke('discord_update_presence', () => undefined);
});

describe('MiniPlayer — render', () => {
  it('mounts without throwing', () => {
    expect(() => renderWithProviders(<MiniPlayer />)).not.toThrow();
  });

  it('renders the always-present titlebar controls (Pin + Open main window)', () => {
    // The Close button is Linux-only — gated on `navigator.platform` and
    // therefore not asserted here so the test passes on every jsdom env.
    const { getByLabelText } = renderWithProviders(<MiniPlayer />);
    expect(getByLabelText('Unpin')).toBeInTheDocument(); // initial state: alwaysOnTop=true
    expect(getByLabelText('Open main window')).toBeInTheDocument();
  });
});

describe('MiniPlayer — click handlers (no bridge)', () => {
  it('clicking Open main window does not throw (bridge emit is a no-op in tests)', () => {
    const { getByLabelText } = renderWithProviders(<MiniPlayer />);
    expect(() => fireEvent.click(getByLabelText('Open main window'))).not.toThrow();
  });

  // The Close affordance is Linux-only — covered by manual smoke per pick 4a.

  it('clicking the Pin button toggles the alwaysOnTop label', () => {
    const { getByLabelText, queryByLabelText } = renderWithProviders(<MiniPlayer />);
    // Initial state: alwaysOnTop=true → label is "Unpin".
    expect(getByLabelText('Unpin')).toBeInTheDocument();

    fireEvent.click(getByLabelText('Unpin'));

    // Bridge command is mocked away; the local React state still flips,
    // so the label moves to "Pin on top".
    expect(queryByLabelText('Pin on top')).toBeInTheDocument();
  });
});
