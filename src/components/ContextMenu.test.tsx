/**
 * `ContextMenu` characterization (Phase F5a).
 *
 * Drives the menu via `usePlayerStore.openContextMenu(...)`, asserts on
 * the rendered items + their click → store-action wiring. Avoids deep
 * snapshots — tests survive a refactor that re-orders or re-styles the
 * markup as long as the menu items + their handlers stay observable.
 */
import type { ServerProfile } from '@/store/authStoreTypes';
import type { Track } from '@/store/playerStoreTypes';
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
  getAlbum: vi.fn(async () => ({ album: { id: 'a1', songs: [] }, songs: [] })),
  reportNowPlaying: vi.fn(async () => undefined),
  scrobbleSong: vi.fn(async () => undefined),
  setRating: vi.fn(async () => undefined),
  star: vi.fn(async () => undefined),
  unstar: vi.fn(async () => undefined),
}));

vi.mock('@/api/lastfm', () => ({
  lastfmScrobble: vi.fn(async () => undefined),
  lastfmUpdateNowPlaying: vi.fn(async () => undefined),
  lastfmLoveTrack: vi.fn(async () => undefined),
  lastfmUnloveTrack: vi.fn(async () => undefined),
  lastfmGetTrackLoved: vi.fn(async () => false),
  lastfmGetAllLovedTracks: vi.fn(async () => []),
}));

vi.mock('@/utils/orbitBulkGuard', () => ({
  orbitBulkGuard: vi.fn(async () => true),
}));

import ContextMenu from './ContextMenu';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { usePlayerStore } from '@/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { makeTrack, makeServer } from '@/test/helpers/factories';
import { onInvoke } from '@/test/mocks/tauri';
import { fireEvent } from '@testing-library/react';

function setUpActiveServer(): ServerProfile {
  const server = makeServer();
  const id = useAuthStore.getState().addServer({
    name: server.name, url: server.url, username: server.username, password: server.password,
  });
  useAuthStore.getState().setActiveServer(id);
  useAuthStore.getState().setLoggedIn(true);
  return { ...server, id };
}

function openMenuFor(type: 'song' | 'album' | 'artist' | 'queue-item' | 'album-song', item: unknown, queueIndex?: number): void {
  usePlayerStore.getState().openContextMenu(100, 100, item as never, type, queueIndex);
}

beforeEach(() => {
  resetAllStores();
  setUpActiveServer();
  // Several menu actions invoke playback / engine commands — stub the common ones.
  onInvoke('audio_play', () => undefined);
  onInvoke('audio_pause', () => undefined);
  onInvoke('audio_stop', () => undefined);
  onInvoke('audio_seek', () => undefined);
  onInvoke('audio_get_state', () => ({ playing: false }));
  onInvoke('audio_update_replay_gain', () => undefined);
  onInvoke('audio_set_normalization', () => undefined);
  onInvoke('discord_update_presence', () => undefined);
  onInvoke('frontend_debug_log', () => undefined);
});

afterEach(() => {
  // Close any open menu so the next test starts clean.
  usePlayerStore.getState().closeContextMenu();
});

describe('ContextMenu — visibility', () => {
  it('renders nothing when the menu is closed', () => {
    const { container } = renderWithProviders(<ContextMenu />);
    // No items, no portal.
    expect(container.querySelector('.context-menu')).toBeNull();
  });

  it('renders the menu when openContextMenu has run', () => {
    openMenuFor('song', makeTrack());
    const { container } = renderWithProviders(<ContextMenu />);
    expect(container.querySelector('.context-menu')).not.toBeNull();
  });

  it('closeContextMenu hides the rendered menu on the next render', () => {
    openMenuFor('song', makeTrack());
    const { container, rerender } = renderWithProviders(<ContextMenu />);
    expect(container.querySelector('.context-menu')).not.toBeNull();

    usePlayerStore.getState().closeContextMenu();
    rerender(<ContextMenu />);
    expect(container.querySelector('.context-menu')).toBeNull();
  });
});

describe('ContextMenu — type=song', () => {
  it('shows Play Now / Play Next / Add to Queue items', () => {
    openMenuFor('song', makeTrack({ id: 'tr-1' }));
    const { getByText } = renderWithProviders(<ContextMenu />);
    expect(getByText('Play Now')).toBeInTheDocument();
    expect(getByText('Play Next')).toBeInTheDocument();
    expect(getByText('Add to Queue')).toBeInTheDocument();
  });

  it('"Play Next" click calls playerStore.playNext with the song', () => {
    const track = makeTrack({ id: 'tr-pn' });
    const playNextSpy = vi.spyOn(usePlayerStore.getState(), 'playNext');
    openMenuFor('song', track);
    const { getByText } = renderWithProviders(<ContextMenu />);

    fireEvent.click(getByText('Play Next'));

    expect(playNextSpy).toHaveBeenCalledTimes(1);
    expect(playNextSpy.mock.calls[0]?.[0]).toHaveLength(1);
    expect(playNextSpy.mock.calls[0]?.[0][0].id).toBe('tr-pn');
  });

  it('"Add to Queue" click calls playerStore.enqueue', () => {
    const track = makeTrack({ id: 'tr-eq' });
    const enqueueSpy = vi.spyOn(usePlayerStore.getState(), 'enqueue');
    openMenuFor('song', track);
    const { getByText } = renderWithProviders(<ContextMenu />);

    fireEvent.click(getByText('Add to Queue'));

    expect(enqueueSpy).toHaveBeenCalled();
    expect(enqueueSpy.mock.calls[0]?.[0]?.[0]?.id).toBe('tr-eq');
  });

  it('selecting any action closes the menu', () => {
    const track = makeTrack();
    openMenuFor('song', track);
    const { getByText } = renderWithProviders(<ContextMenu />);

    fireEvent.click(getByText('Play Next'));
    expect(usePlayerStore.getState().contextMenu.isOpen).toBe(false);
  });
});

describe('ContextMenu — type=album', () => {
  it('shows the album surface (Open Album / Play Next / Enqueue Album / Go to Artist)', () => {
    openMenuFor('album', {
      id: 'al-1', name: 'Album', artist: 'Artist', artistId: 'ar-1',
      songCount: 5, duration: 1200, year: 2024,
    });
    const { getByText } = renderWithProviders(<ContextMenu />);
    expect(getByText('Open Album')).toBeInTheDocument();
    expect(getByText('Play Next')).toBeInTheDocument();
    expect(getByText('Enqueue Album')).toBeInTheDocument();
    expect(getByText('Go to Artist')).toBeInTheDocument();
  });
});

describe('ContextMenu — type=artist', () => {
  it('shows the artist menu surface (Start Radio + share-link affordances)', () => {
    openMenuFor('artist', {
      id: 'ar-1', name: 'Artist', albumCount: 3,
    });
    const { container } = renderWithProviders(<ContextMenu />);
    expect(container.querySelector('.context-menu')).not.toBeNull();
    expect(container.textContent).toMatch(/Start Radio/i);
    expect(container.textContent).toMatch(/share/i);
  });
});

describe('ContextMenu — type=queue-item', () => {
  it('shows a Remove from Queue affordance the song menu does not have', () => {
    const track = makeTrack({ id: 'q-1' });
    usePlayerStore.setState({ queue: [track], queueIndex: 0, currentTrack: track });
    openMenuFor('queue-item', track, 0);
    const { container } = renderWithProviders(<ContextMenu />);
    expect(container.querySelector('.context-menu')).not.toBeNull();
    // The Remove option's i18n key (queue.removeFromQueue) ends up rendered;
    // assert *something* queue-flavoured appears (we don't pin the exact
    // wording so a translation tweak doesn't flip the test).
    expect(container.textContent).toMatch(/remove/i);
  });
});

describe('ContextMenu — Escape closes', () => {
  it('Escape on the menu closes it', () => {
    openMenuFor('song', makeTrack());
    const { container } = renderWithProviders(<ContextMenu />);
    const menu = container.querySelector('.context-menu') as HTMLElement;
    expect(menu).not.toBeNull();

    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(usePlayerStore.getState().contextMenu.isOpen).toBe(false);
  });
});
