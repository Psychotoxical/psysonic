import type { TFunction } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSmartFilters } from '@/features/playlist/utils/playlistsSmart';
import { createSmartEditorSession } from '@/features/playlist/utils/smartPlaylistEditor';
import { parseSmartRulesDocument } from '@/features/playlist/utils/smartPlaylistRules';
import { runPlaylistsSaveSmart } from '@/features/playlist/utils/runPlaylistsSaveSmart';

const {
  ndCreateSmartPlaylistMock,
  ndUpdateSmartPlaylistMock,
  ndGetSmartPlaylistMock,
  getPlaylistForServerMock,
  showToastMock,
  setPlaylistSongIdsMock,
} = vi.hoisted(() => ({
  ndCreateSmartPlaylistMock: vi.fn(),
  ndUpdateSmartPlaylistMock: vi.fn(),
  ndGetSmartPlaylistMock: vi.fn(),
  getPlaylistForServerMock: vi.fn(),
  showToastMock: vi.fn(),
  setPlaylistSongIdsMock: vi.fn(),
}));

vi.mock('@/lib/api/navidromeSmart', () => ({
  ndCreateSmartPlaylist: ndCreateSmartPlaylistMock,
  ndUpdateSmartPlaylist: ndUpdateSmartPlaylistMock,
  ndGetSmartPlaylist: ndGetSmartPlaylistMock,
}));

vi.mock('@/features/playlist/store/playlistStore', () => ({
  usePlaylistStore: {
    getState: () => ({ playlists: [] }),
    setState: vi.fn(),
  },
}));

vi.mock('@/store/playlistMembershipStore', () => ({
  usePlaylistMembershipStore: { getState: () => ({ setPlaylistSongIds: setPlaylistSongIdsMock }) },
}));

vi.mock('@/lib/api/subsonicPlaylists', () => ({
  getPlaylistForServer: getPlaylistForServerMock,
}));

vi.mock('@/lib/dom/toast', () => ({ showToast: showToastMock }));

function makeDeps(overrides: Record<string, unknown> = {}) {
  const rules = { all: [{ is: { genre: 'Jazz' } }] };
  return {
    isNavidromeServer: true,
    serverId: 'server-b',
    smartFilters: { ...defaultSmartFilters, name: 'Owned mix' },
    smartSession: createSmartEditorSession({ name: 'Owned mix', rules }),
    allGenres: ['Jazz'],
    editingSmartId: 'smart-1' as string | null,
    playlists: [],
    fetchPlaylists: vi.fn(async () => undefined),
    t: ((key: string) => key) as TFunction,
    setPendingSmart: vi.fn(),
    setCreatingSmart: vi.fn(),
    setEditingSmartId: vi.fn(),
    setSmartFilters: vi.fn(),
    setSmartSession: vi.fn(),
    setGenreQuery: vi.fn(),
    setCreatingSmartBusy: vi.fn(),
    setEditingSmartServerId: vi.fn(),
    ...overrides,
  };
}

describe('runPlaylistsSaveSmart', () => {
  beforeEach(() => {
    ndCreateSmartPlaylistMock.mockReset();
    ndUpdateSmartPlaylistMock.mockReset();
    ndGetSmartPlaylistMock.mockReset();
    getPlaylistForServerMock.mockReset();
    showToastMock.mockReset();
    setPlaylistSongIdsMock.mockReset();
    ndGetSmartPlaylistMock.mockResolvedValue({ id: 'smart-1', rules: { all: [{ is: { genre: 'Jazz' } }] } });
    getPlaylistForServerMock.mockResolvedValue({
      playlist: { id: 'smart-1', name: 'Owned mix', songCount: 2 },
      songs: [{ id: 's1' }, { id: 's2' }],
    });
  });

  it('saves the exact entered name without a psy-smart- prefix', async () => {
    ndUpdateSmartPlaylistMock.mockResolvedValue({ id: 'smart-1' });
    const deps = makeDeps();

    await runPlaylistsSaveSmart(deps);

    expect(ndUpdateSmartPlaylistMock).toHaveBeenCalledWith(
      'smart-1',
      'Owned mix',
      expect.any(Object),
      expect.objectContaining({ serverId: 'server-b' }),
    );
    expect(ndUpdateSmartPlaylistMock.mock.calls[0]?.[2]).not.toHaveProperty('sync');
    expect(deps.setEditingSmartServerId).toHaveBeenCalledWith(null);
    expect(deps.setCreatingSmart).toHaveBeenCalledWith(false);
  });

  it('creates without a prefix and without sync', async () => {
    ndCreateSmartPlaylistMock.mockResolvedValue({ id: 'new-1' });
    ndGetSmartPlaylistMock.mockResolvedValue({ id: 'new-1', rules: { all: [{ is: { genre: 'Jazz' } }] } });
    getPlaylistForServerMock.mockResolvedValue({
      playlist: { id: 'new-1', name: 'Owned mix', songCount: 1 },
      songs: [{ id: 's1' }],
    });
    const deps = makeDeps({ editingSmartId: null });

    await runPlaylistsSaveSmart(deps);

    expect(ndCreateSmartPlaylistMock).toHaveBeenCalledWith(
      'Owned mix',
      expect.any(Object),
      expect.objectContaining({ serverId: 'server-b' }),
    );
    expect(ndCreateSmartPlaylistMock.mock.calls[0]?.[2]).not.toEqual(true);
    expect(ndCreateSmartPlaylistMock.mock.calls[0]?.[2]).not.toHaveProperty('sync');
  });

  it('rejects empty criteria before calling the API', async () => {
    const deps = makeDeps({
      smartSession: {
        ...createSmartEditorSession({ name: 'Empty' }),
        document: parseSmartRulesDocument({ all: [] }),
      },
    });

    await runPlaylistsSaveSmart(deps);

    expect(ndUpdateSmartPlaylistMock).not.toHaveBeenCalled();
    expect(ndCreateSmartPlaylistMock).not.toHaveBeenCalled();
    expect(showToastMock).toHaveBeenCalledWith('smartPlaylists.emptyCriteria', 3500, 'error');
  });

  it('warns when the persisted rules drop sent clauses', async () => {
    ndUpdateSmartPlaylistMock.mockResolvedValue({ id: 'smart-1' });
    ndGetSmartPlaylistMock.mockResolvedValue({
      id: 'smart-1',
      rules: { all: [{ is: { genre: 'Jazz' } }], limit: 10 },
    });
    const deps = makeDeps({
      smartSession: createSmartEditorSession({
        name: 'Owned mix',
        rules: { all: [{ is: { genre: 'Jazz' } }, { contains: { title: 'live' } }], limit: 10 },
      }),
    });

    await runPlaylistsSaveSmart(deps);

    expect(showToastMock).toHaveBeenCalledWith('smartPlaylists.droppedClauses', 4500, 'warning');
  });

  it('saves a copy as a create without rewriting the original', async () => {
    ndCreateSmartPlaylistMock.mockResolvedValue({ id: 'copy-1' });
    ndGetSmartPlaylistMock.mockResolvedValue({
      id: 'copy-1',
      rules: { all: [{ is: { genre: 'Jazz' } }] },
    });
    getPlaylistForServerMock.mockResolvedValue({
      playlist: { id: 'copy-1', name: 'Owned mix', songCount: 1 },
      songs: [{ id: 's1' }],
    });

    await runPlaylistsSaveSmart(makeDeps({ saveAsCopy: true }));

    expect(ndCreateSmartPlaylistMock).toHaveBeenCalledWith(
      'Owned mix',
      expect.any(Object),
      expect.objectContaining({ serverId: 'server-b' }),
    );
    expect(ndUpdateSmartPlaylistMock).not.toHaveBeenCalled();
  });

  it('reads the first page of tracks after save', async () => {
    ndCreateSmartPlaylistMock.mockResolvedValue({ id: 'new-1' });
    ndGetSmartPlaylistMock.mockResolvedValue({ id: 'new-1', rules: { all: [{ is: { genre: 'Jazz' } }] } });
    const deps = makeDeps({ editingSmartId: null });

    await runPlaylistsSaveSmart(deps);

    expect(getPlaylistForServerMock).toHaveBeenCalledWith('server-b', 'new-1');
    expect(setPlaylistSongIdsMock).toHaveBeenCalledWith('new-1', ['s1', 's2'], 'server-b');
  });

  it('does not close a newer editor when an older save completes', async () => {
    let resolveSave!: (value: { id: string }) => void;
    ndUpdateSmartPlaylistMock.mockReturnValue(new Promise(resolve => { resolveSave = resolve; }));
    const deps = makeDeps();
    let current = true;
    const save = runPlaylistsSaveSmart({ ...deps, isCurrent: () => current });

    current = false;
    resolveSave({ id: 'smart-1' });
    await save;

    expect(deps.fetchPlaylists).not.toHaveBeenCalled();
    expect(deps.setCreatingSmart).not.toHaveBeenCalled();
    expect(deps.setEditingSmartServerId).not.toHaveBeenCalled();
    expect(deps.setCreatingSmartBusy).not.toHaveBeenCalledWith(false);
  });
});
