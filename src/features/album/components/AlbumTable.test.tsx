import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';

const navigate = vi.hoisted(() => vi.fn());
const navigateToAlbum = vi.hoisted(() => vi.fn());
const openContextMenu = vi.hoisted(() => vi.fn());

vi.mock('@/cover/useLibraryCoverRef', () => ({
  useAlbumCoverRef: () => null,
}));
vi.mock('@/lib/dnd/DragDropContext', () => ({
  useDragDrop: () => ({ startDrag: vi.fn(), payload: null, isDragging: false }),
}));
vi.mock('@/generated/bindings', () => ({
  commands: {
    libraryResolveArtistIds: vi.fn().mockResolvedValue({ status: 'ok', data: [] }),
    // The table warms its row thumbs through the shared grid's cover peek.
    coverCachePeekBatch: vi.fn().mockResolvedValue({ status: 'ok', data: [] }),
  },
}));
vi.mock('@/features/album/hooks/useNavigateToAlbum', () => ({
  useNavigateToAlbum: () => navigateToAlbum,
}));
vi.mock('@/features/playback', () => ({
  usePlayerStore: (selector: (s: { openContextMenu: unknown }) => unknown) =>
    selector({ openContextMenu }),
}));
vi.mock('react-router', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => navigate,
}));

import AlbumTable from './AlbumTable';

function album(overrides: Partial<SubsonicAlbum> & Pick<SubsonicAlbum, 'id' | 'name'>): SubsonicAlbum {
  return {
    artist: 'Some Artist',
    artistId: 'ar-1',
    songCount: 0,
    duration: 0,
    ...overrides,
  };
}

const ALBUMS: SubsonicAlbum[] = [
  album({
    id: 'al-1',
    name: 'First Record',
    artist: 'Alpha',
    songCount: 12,
    duration: 3671,
    year: 1994,
    created: '2026-02-03T10:00:00Z',
  }),
  album({ id: 'al-2', name: 'Second Record', artist: 'Beta', songCount: 4, duration: 240 }),
];

function renderTable(props: Partial<React.ComponentProps<typeof AlbumTable>> = {}) {
  return renderWithProviders(
    <AlbumTable
      albums={ALBUMS}
      itemKey={a => a.id}
      scrollRootId="test-viewport"
      disableVirtualization
      selectionMode={false}
      selectedIds={new Set()}
      onToggleSelect={() => {}}
      selectedAlbums={[]}
      {...props}
    />,
  );
}

describe('AlbumTable', () => {
  beforeEach(() => {
    navigate.mockReset();
    navigateToAlbum.mockReset();
    openContextMenu.mockReset();
  });

  it('renders one row per album with its metadata columns', () => {
    renderTable();

    const rows = screen.getAllByRole('row');
    // Header row plus one row per album.
    expect(rows).toHaveLength(3);
    const first = rows[1];
    expect(within(first).getByRole('button', { name: /First Record/ })).toBeTruthy();
    expect(within(first).getByText('12')).toBeTruthy();
    expect(within(first).getByText('1994')).toBeTruthy();
    expect(within(first).getByText('1:01:11')).toBeTruthy();
  });

  // Every column is guaranteed by the API shape but not by the data: an album
  // with no year or an unparsable date must leave a placeholder, never a blank
  // cell that reads as a rendering fault.
  it('places a dash in columns the server left empty', () => {
    const rows = renderTable().container.querySelectorAll('.album-table__row');
    const second = rows[1] as HTMLElement;
    expect(within(second).getAllByText('\u2014').length).toBeGreaterThanOrEqual(2);
  });

  it('reports the full list length to assistive tech, not the mounted rows', () => {
    renderTable();
    expect(screen.getByRole('table').getAttribute('aria-rowcount')).toBe('3');
    const rows = screen.getAllByRole('row');
    expect(rows[1].getAttribute('aria-rowindex')).toBe('2');
    expect(rows[2].getAttribute('aria-rowindex')).toBe('3');
  });

  it('opens the album when a row is clicked outside selection mode', () => {
    renderTable();
    fireEvent.click(screen.getByRole('button', { name: /First Record/ }));
    expect(navigateToAlbum).toHaveBeenCalledWith('al-1', { search: undefined });
  });

  it('toggles selection instead of navigating while selection mode is on', () => {
    const onToggleSelect = vi.fn();
    renderTable({ selectionMode: true, onToggleSelect });

    fireEvent.click(screen.getByRole('button', { name: /First Record/ }), { shiftKey: true });
    expect(navigateToAlbum).not.toHaveBeenCalled();
    expect(onToggleSelect).toHaveBeenCalledWith(ALBUMS[0], { shiftKey: true });
  });

  it('marks the active sort column and drives the page sort from the header', () => {
    const onChange = vi.fn();
    renderTable({ sort: { value: 'alphabeticalByName', onChange } });

    const headers = screen.getAllByRole('columnheader');
    const title = headers.find(h => h.classList.contains('album-table__cell--title'))!;
    const artist = headers.find(h => h.classList.contains('album-table__cell--artist'))!;
    expect(title.getAttribute('aria-sort')).toBe('ascending');
    expect(artist.getAttribute('aria-sort')).toBe('none');

    fireEvent.click(within(artist).getByRole('button'));
    expect(onChange).toHaveBeenCalledWith('alphabeticalByArtist');
  });

  // New Releases has no sort control, so its headers must not offer one —
  // a clickable header there would promise an order the page cannot produce.
  it('renders static headers on a page without a sort control', () => {
    renderTable();
    const headers = screen.getAllByRole('columnheader');
    const title = headers.find(h => h.classList.contains('album-table__cell--title'))!;
    expect(within(title).queryByRole('button')).toBeNull();
    expect(title.getAttribute('aria-sort')).toBeNull();
  });

  it('opens the context menu for the row it was fired on', () => {
    renderTable();
    const rows = screen.getAllByRole('row');
    fireEvent.contextMenu(rows[2]);
    expect(openContextMenu).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      ALBUMS[1],
      'album',
    );
  });

  it('passes the whole selection to the context menu while selecting', () => {
    renderTable({ selectionMode: true, selectedAlbums: ALBUMS, selectedIds: new Set(['al-1', 'al-2']) });
    fireEvent.contextMenu(screen.getAllByRole('row')[1]);
    expect(openContextMenu).toHaveBeenCalledWith(
      expect.any(Number),
      expect.any(Number),
      ALBUMS,
      'multi-album',
    );
  });
});
