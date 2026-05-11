/**
 * `QueuePanel` characterization (Phase F5b).
 *
 * Includes the §4.4 regression test from the v2 plan — queue DnD must
 * NOT use HTML5 native `dataTransfer.setData`/`draggable=true`. The
 * project's custom `psy-drop` system sidesteps WebView2's
 * `text/plain`-only restriction by avoiding HTML5 DnD entirely; a
 * refactor that re-introduces native DnD would silently break Windows.
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

vi.mock('@/utils/orbitBulkGuard', () => ({
  orbitBulkGuard: vi.fn(async () => true),
}));

import QueuePanel from './QueuePanel';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { usePlayerStore } from '@/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { makeTrack, makeTracks } from '@/test/helpers/factories';
import { onInvoke } from '@/test/mocks/tauri';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

beforeEach(() => {
  resetAllStores();
  const id = useAuthStore.getState().addServer({
    name: 'T', url: 'https://x.test', username: 'u', password: 'p',
  });
  useAuthStore.getState().setActiveServer(id);
  onInvoke('audio_play', () => undefined);
  onInvoke('audio_pause', () => undefined);
  onInvoke('audio_stop', () => undefined);
  onInvoke('audio_seek', () => undefined);
  onInvoke('audio_get_state', () => ({ playing: false }));
  onInvoke('audio_update_replay_gain', () => undefined);
  onInvoke('discord_update_presence', () => undefined);
});

describe('QueuePanel — render surface', () => {
  it('renders an empty-queue affordance when the queue is empty', () => {
    const { container } = renderWithProviders(<QueuePanel />);
    expect(container.querySelector('.queue-panel')).not.toBeNull();
    // No queue rows present.
    expect(container.querySelectorAll('[data-queue-idx]').length).toBe(0);
  });

  it('renders one row per queue track with the matching data-queue-idx', () => {
    const tracks = makeTracks(3);
    usePlayerStore.setState({
      queue: tracks,
      queueIndex: 0,
      currentTrack: tracks[0],
    });
    const { container } = renderWithProviders(<QueuePanel />);
    const rows = container.querySelectorAll<HTMLElement>('[data-queue-idx]');
    expect(rows.length).toBe(3);
    expect(rows[0]?.getAttribute('data-queue-idx')).toBe('0');
    expect(rows[2]?.getAttribute('data-queue-idx')).toBe('2');
  });

  it('renders each queue row with the track title text', () => {
    const t1 = makeTrack({ id: 'q1', title: 'Test Song A' });
    const t2 = makeTrack({ id: 'q2', title: 'Test Song B' });
    usePlayerStore.setState({
      queue: [t1, t2],
      queueIndex: 0,
      currentTrack: t1,
    });
    const { getAllByText, getByText } = renderWithProviders(<QueuePanel />);
    // Title A appears both in the now-playing section and in the row;
    // assert at least one match. Title B only lives in its row.
    expect(getAllByText('Test Song A').length).toBeGreaterThan(0);
    expect(getByText('Test Song B')).toBeInTheDocument();
  });
});

describe('QueuePanel — toolbar', () => {
  it('exposes Shuffle / Save Playlist / Load Playlist / Share Queue / Clear via aria-label', () => {
    const tracks = makeTracks(3);
    usePlayerStore.setState({
      queue: tracks,
      queueIndex: 0,
      currentTrack: tracks[0],
    });
    const { getByLabelText } = renderWithProviders(<QueuePanel />);
    expect(getByLabelText('Shuffle queue')).toBeInTheDocument();
    expect(getByLabelText('Save Playlist')).toBeInTheDocument();
    expect(getByLabelText('Load Playlist')).toBeInTheDocument();
    expect(getByLabelText('Copy queue share link')).toBeInTheDocument();
    expect(getByLabelText('Clear')).toBeInTheDocument();
  });

  it('Shuffle button is disabled when the queue has fewer than 2 tracks', () => {
    usePlayerStore.setState({
      queue: [makeTrack()],
      queueIndex: 0,
      currentTrack: makeTrack(),
    });
    const { getByLabelText } = renderWithProviders(<QueuePanel />);
    const shuffle = getByLabelText('Shuffle queue') as HTMLButtonElement;
    expect(shuffle.disabled).toBe(true);
  });
});

describe('QueuePanel — DnD architecture pin (§4.4 of v2 plan)', () => {
  // The custom `psy-drop` event system in DragDropContext sidesteps
  // WebView2's `text/plain`-only DnD restriction by avoiding HTML5 native
  // DnD entirely. These tests make sure a refactor that "modernises" the
  // queue back to native HTML5 DnD breaks loudly.

  it('queue rows do not declare draggable=true (no HTML5 native drag)', () => {
    usePlayerStore.setState({
      queue: makeTracks(3),
      queueIndex: 0,
      currentTrack: makeTrack(),
    });
    const { container } = renderWithProviders(<QueuePanel />);
    const rows = container.querySelectorAll<HTMLElement>('[data-queue-idx]');
    for (const row of rows) {
      expect(row.getAttribute('draggable')).not.toBe('true');
    }
  });

  it('the source file has no `dataTransfer.setData` / `dataTransfer.getData` / `onDragStart` / `onDrop` JSX usage', () => {
    // Static check — protect against re-introducing native DnD. The
    // `dragenter` / `dragover` props are allowed because the document
    // listens for them to render the drop indicator without acting as
    // a sink for HTML5 payloads.
    const source = readFileSync(join(process.cwd(), 'src/components/QueuePanel.tsx'), 'utf8');
    expect(source).not.toMatch(/dataTransfer\.setData/);
    expect(source).not.toMatch(/dataTransfer\.getData/);
    expect(source).not.toMatch(/\bonDragStart\s*=/);
    expect(source).not.toMatch(/\bonDrop\s*=/);
  });

  it('the source file does not use `application/json` MIME anywhere (WebView2 restriction)', () => {
    const source = readFileSync(join(process.cwd(), 'src/components/QueuePanel.tsx'), 'utf8');
    expect(source).not.toMatch(/application\/json/);
  });
});

afterEach(() => {
  usePlayerStore.getState().closeContextMenu();
});
