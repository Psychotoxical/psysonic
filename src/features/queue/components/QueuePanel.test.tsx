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

vi.mock('@/lib/api/subsonic', () => ({
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


vi.mock('@/features/orbit/utils/orbitBulkGuard', () => ({
  orbitBulkGuard: vi.fn(async () => true),
}));

import QueuePanel from '@/features/queue/components/QueuePanel';
import { fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { resetAllStores } from '@/test/helpers/storeReset';
import { makeTrack, makeTracks, seedQueue } from '@/test/helpers/factories';
import { onInvoke, registerDefaultCoverInvokeHandlers } from '@/test/mocks/tauri';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

beforeEach(() => {
  resetAllStores();
  const id = useAuthStore.getState().addServer({
    name: 'T', url: 'https://x.test', username: 'u', password: 'p',
  });
  useAuthStore.getState().setActiveServer(id);
  registerDefaultCoverInvokeHandlers();
  onInvoke('audio_play', () => undefined);
  onInvoke('audio_pause', () => undefined);
  onInvoke('audio_stop', () => undefined);
  onInvoke('audio_seek', () => undefined);
  onInvoke('audio_get_state', () => ({ playing: false }));
  onInvoke('audio_update_replay_gain', () => undefined);
  onInvoke('discord_update_presence', () => undefined);
  onInvoke('library_get_recent_play_sessions', () => []);
});

describe('QueuePanel — render surface', () => {
  // jsdom has no layout, so the virtualized QueueList sees a 0px viewport and
  // renders nothing. @tanstack/virtual-core measures via offsetHeight, so give
  // the scroll viewport a height and rows a fixed height — then the virtualizer
  // produces rows the way it does in the browser.
  let offsetSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    offsetSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('queue-list') ? 600 : 52;
      });
    // These characterize the full-queue rendering (one row per track), which is
    // playlist mode. The default mode is 'queue' (upcoming-only), so pin it.
    useAuthStore.getState().setQueueDisplayMode('playlist');
  });
  afterEach(() => offsetSpy.mockRestore());

  it('renders an empty-queue affordance when the queue is empty', () => {
    const { container } = renderWithProviders(<QueuePanel />);
    expect(container.querySelector('.queue-panel')).not.toBeNull();
    // No queue rows present.
    expect(container.querySelectorAll('[data-queue-idx]').length).toBe(0);
  });

  it('renders one row per queue track with the matching data-queue-idx', () => {
    const tracks = makeTracks(3);
    seedQueue(tracks, { index: 0, currentTrack: tracks[0] });
    const { container } = renderWithProviders(<QueuePanel />);
    const rows = container.querySelectorAll<HTMLElement>('[data-queue-idx]');
    expect(rows.length).toBe(3);
    expect(rows[0]?.getAttribute('data-queue-idx')).toBe('0');
    expect(rows[2]?.getAttribute('data-queue-idx')).toBe('2');
  });

  it('renders each queue row with the track title text', () => {
    const t1 = makeTrack({ id: 'q1', title: 'Test Song A' });
    const t2 = makeTrack({ id: 'q2', title: 'Test Song B' });
    seedQueue([t1, t2], { index: 0, currentTrack: t1 });
    const { getAllByText, getByText } = renderWithProviders(<QueuePanel />);
    // Title A appears both in the now-playing section and in the row;
    // assert at least one match. Title B only lives in its row.
    expect(getAllByText('Test Song A').length).toBeGreaterThan(0);
    expect(getByText('Test Song B')).toBeInTheDocument();
  });
});

describe('QueuePanel — display mode', () => {
  // Same virtualizer layout shim as the render-surface block: jsdom has no
  // layout, so give the scroll viewport a height and rows a fixed height.
  let offsetSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    offsetSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('queue-list') ? 600 : 52;
      });
  });
  afterEach(() => offsetSpy.mockRestore());

  it('playlist mode: header reads "Playlist", full queue renders, no "Next Tracks" divider', () => {
    const tracks = makeTracks(4);
    useAuthStore.getState().setQueueDisplayMode('playlist');
    seedQueue(tracks, { index: 1, currentTrack: tracks[1] });
    const { container } = renderWithProviders(<QueuePanel />);
    expect(container.querySelector('.queue-header h2')?.textContent).toBe('Playlist');
    const idxs = [...container.querySelectorAll('[data-queue-idx]')].map(r => r.getAttribute('data-queue-idx'));
    expect(idxs).toEqual(['0', '1', '2', '3']);
    expect(container.textContent).not.toContain('Next Tracks');
  });

  it('queue mode: header reads "Queue", only upcoming rows render with absolute indices + titles', () => {
    const tracks = makeTracks(5);
    useAuthStore.getState().setQueueDisplayMode('queue');
    seedQueue(tracks, { index: 1, currentTrack: tracks[1] });
    const { container } = renderWithProviders(<QueuePanel />);
    expect(container.querySelector('.queue-header h2')?.textContent).toBe('Queue');
    const rows = [...container.querySelectorAll<HTMLElement>('[data-queue-idx]')];
    // Played (0) + current (1) are gone; only 2,3,4 remain, with absolute idx.
    expect(rows.map(r => r.getAttribute('data-queue-idx'))).toEqual(['2', '3', '4']);
    // The first displayed row maps to the absolute track at index 2, not 0.
    expect(rows[0]?.textContent).toContain(tracks[2].title);
    expect(container.textContent).toContain('Next Tracks');
  });

  it('queue mode with the current track last: shows the "no upcoming" empty state, no rows', () => {
    const tracks = makeTracks(3);
    useAuthStore.getState().setQueueDisplayMode('queue');
    seedQueue(tracks, { index: 2, currentTrack: tracks[2] });
    const { container } = renderWithProviders(<QueuePanel />);
    expect(container.querySelectorAll('[data-queue-idx]').length).toBe(0);
    expect(container.textContent).toContain('No upcoming tracks');
  });

  it('header mode-toggle button advances queueDisplayMode (default queue → timeline)', () => {
    seedQueue(makeTracks(3), { index: 0, currentTrack: makeTrack() });
    const { container } = renderWithProviders(<QueuePanel />);
    const toggle = container.querySelector<HTMLButtonElement>('.queue-header .queue-action-btn');
    expect(toggle?.getAttribute('aria-label')).toBe('Timeline');
    toggle!.click();
    expect(useAuthStore.getState().queueDisplayMode).toBe('timeline');
  });

  it('timeline mode: renders current + upcoming only (not played queue prefix)', () => {
    const tracks = makeTracks(4);
    useAuthStore.getState().setQueueDisplayMode('timeline');
    seedQueue(tracks, { index: 1, currentTrack: tracks[1] });
    const { container } = renderWithProviders(<QueuePanel />);
    const idxs = [...container.querySelectorAll('[data-queue-idx]')].map(r => r.getAttribute('data-queue-idx'));
    expect(idxs).toEqual(['1', '2', '3']);
  });
});

describe('QueuePanel — toolbar', () => {
  it('exposes Shuffle / Playlist / Share Queue / Clear / AutoDJ via aria-label', () => {
    const tracks = makeTracks(3);
    seedQueue(tracks, { index: 0, currentTrack: tracks[0] });
    const { getByLabelText } = renderWithProviders(<QueuePanel />);
    expect(getByLabelText('Shuffle queue')).toBeInTheDocument();
    expect(getByLabelText('Playlist')).toBeInTheDocument();
    expect(getByLabelText('Copy queue share link')).toBeInTheDocument();
    expect(getByLabelText('Clear queue')).toBeInTheDocument();
    expect(getByLabelText('AutoDJ')).toBeInTheDocument();
  });

  it('Save and Load live inside the Playlist submenu, not directly on the toolbar', () => {
    const tracks = makeTracks(3);
    seedQueue(tracks, { index: 0, currentTrack: tracks[0] });
    const { getByLabelText, container } = renderWithProviders(<QueuePanel />);
    // The submenu is closed initially.
    expect(container.querySelector('.queue-menu')).toBeNull();
    fireEvent.click(getByLabelText('Playlist'));
    const menu = container.querySelector('.queue-menu');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain('Save Playlist');
    expect(menu?.textContent).toContain('Load Playlist');
  });

  it('Shuffle button is disabled when the queue has fewer than 2 tracks', () => {
    seedQueue([makeTrack()], { index: 0, currentTrack: makeTrack() });
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
    seedQueue(makeTracks(3), { index: 0, currentTrack: makeTrack() });
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
    const source = readFileSync(join(process.cwd(), 'src/features/queue/components/QueuePanel.tsx'), 'utf8');
    expect(source).not.toMatch(/dataTransfer\.setData/);
    expect(source).not.toMatch(/dataTransfer\.getData/);
    expect(source).not.toMatch(/\bonDragStart\s*=/);
    expect(source).not.toMatch(/\bonDrop\s*=/);
  });

  it('the source file does not use `application/json` MIME anywhere (WebView2 restriction)', () => {
    const source = readFileSync(join(process.cwd(), 'src/features/queue/components/QueuePanel.tsx'), 'utf8');
    expect(source).not.toMatch(/application\/json/);
  });
});

afterEach(() => {
  usePlayerStore.getState().closeContextMenu();
});
