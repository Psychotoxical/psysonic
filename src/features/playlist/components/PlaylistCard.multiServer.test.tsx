import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/helpers/renderWithProviders';
import PlaylistCard from '@/features/playlist/components/PlaylistCard';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';

vi.mock('@/cover/AlbumCoverArtImage', () => ({
  AlbumCoverArtImage: ({ coverArt }: { coverArt?: string }) => <span data-testid={`cover-${coverArt}`} />,
}));
vi.mock('@/lib/dnd/DragDropContext', () => ({ useDragSource: () => ({}) }));
vi.mock('@/features/playback/store/playerStore', () => ({ usePlayerStore: () => vi.fn() }));

const playlist = (serverId: string): SubsonicPlaylist => ({
  id: 'same', serverId, name: 'psy-smart-mix', songCount: 99, duration: 99, created: '', changed: '',
});

describe('PlaylistCard multi-server identity', () => {
  it('renders each equal-id card from its own cover/count/pending namespace', () => {
    const props = {
      selectionMode: false,
      selectedIds: new Set<string>(),
      selectedPlaylists: [],
      toggleSelect: vi.fn(),
      isPlaylistDeletable: () => false,
      deleteConfirmId: null,
      setDeleteConfirmId: vi.fn(),
      handleOpenSmartEditor: vi.fn(),
      handleDelete: vi.fn(),
      handlePlay: vi.fn(),
      playingId: 's2:same',
      smartCoverIdsByPlaylist: { 's1:same': ['cover-a'], 's2:same': ['cover-b'] },
      pendingSmart: [{ serverId: 's2', id: 'same', name: 'psy-smart-mix', attempts: 0 }],
      filteredSongCountByPlaylist: { 's1:same': 1, 's2:same': 2 },
      filteredDurationByPlaylist: { 's1:same': 10, 's2:same': 20 },
    };
    const { getAllByText, getAllByTestId, container } = renderWithProviders(
      <>
        <PlaylistCard pl={playlist('s1')} {...props} />
        <PlaylistCard pl={playlist('s2')} {...props} />
      </>,
    );

    expect(getAllByTestId('cover-cover-a')).toHaveLength(4);
    expect(getAllByTestId('cover-cover-b')).toHaveLength(4);
    const metadata = [...container.querySelectorAll('.album-card-artist')].map(element => element.textContent);
    expect(metadata[0]).toContain('1 song');
    expect(metadata[1]).toContain('2 songs');
    expect(getAllByText('mix')).toHaveLength(2);
    expect(container.querySelectorAll('[data-tooltip="Loading…"]')).toHaveLength(1);
    expect(container.querySelectorAll('.spinner')).toHaveLength(1);
  });
});
