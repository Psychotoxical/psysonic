import { describe, expect, it, vi } from 'vitest';
import { runPlaylistsOpenSmartEditor } from '@/features/playlist/utils/runPlaylistsOpenSmartEditor';

const { ndGetSmartPlaylist, ndListSmartPlaylists, showToast } = vi.hoisted(() => ({
  ndGetSmartPlaylist: vi.fn(),
  ndListSmartPlaylists: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock('@/lib/api/navidromeSmart', () => ({ ndGetSmartPlaylist, ndListSmartPlaylists }));
vi.mock('@/lib/dom/toast', () => ({ showToast }));

describe('runPlaylistsOpenSmartEditor', () => {
  it('blocks a foreign owner server before any Navidrome request', async () => {
    const t = vi.fn((key: string) => key);
    await runPlaylistsOpenSmartEditor({
      pl: { id: 'same', serverId: 's2', name: 'psy-smart-mix', songCount: 0, duration: 0, created: '', changed: '' },
      ownerServerId: 's2',
      activeServerId: 's1',
      isOwnerNavidrome: true,
      ownerServerName: 'Remote',
      allGenres: [],
      t: t as never,
      setSmartFilters: vi.fn(),
      setEditingSmartId: vi.fn(),
      setGenreQuery: vi.fn(),
      setCreating: vi.fn(),
      setCreatingSmart: vi.fn(),
      setCreatingSmartBusy: vi.fn(),
    });

    expect(ndGetSmartPlaylist).not.toHaveBeenCalled();
    expect(ndListSmartPlaylists).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('smartPlaylists.foreignServerDisabled', 4000, 'warning');
  });
});
