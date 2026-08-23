import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { runPlaylistsOpenSmartEditor } from '@/features/playlist/utils/runPlaylistsOpenSmartEditor';

const { ndGetSmartPlaylistMock, ndListPlaylistsMock, showToastMock } = vi.hoisted(() => ({
  ndGetSmartPlaylistMock: vi.fn(),
  ndListPlaylistsMock: vi.fn(),
  showToastMock: vi.fn(),
}));

vi.mock('@/lib/api/navidromeSmart', () => ({
  ndGetSmartPlaylist: ndGetSmartPlaylistMock,
  ndListPlaylists: ndListPlaylistsMock,
}));

vi.mock('@/lib/dom/toast', () => ({
  showToast: showToastMock,
}));

function makeDeps(playlist: {
  name: string;
  smart?: boolean;
  comment?: string;
  public?: boolean;
  owner?: string;
}) {
  return {
    pl: {
      id: 'playlist-1',
      songCount: 0,
      duration: 0,
      created: '',
      changed: '',
      ...playlist,
    },
    serverId: 'server-a',
    isNavidromeServer: true,
    allGenres: [],
    t: ((key: string) => key) as TFunction,
    setSmartFilters: vi.fn(),
    setSmartSession: vi.fn(),
    setEditingSmartId: vi.fn(),
    setGenreQuery: vi.fn(),
    setCreating: vi.fn(),
    setCreatingSmart: vi.fn(),
    setCreatingSmartBusy: vi.fn(),
    setEditingSmartServerId: vi.fn(),
  };
}

describe('runPlaylistsOpenSmartEditor classification', () => {
  beforeEach(() => {
    ndGetSmartPlaylistMock.mockReset();
    ndListPlaylistsMock.mockReset();
    showToastMock.mockReset();
  });

  it('does not use a legacy prefix when native metadata says regular', async () => {
    const deps = makeDeps({ name: 'psy-smart-Regular', smart: false });

    await runPlaylistsOpenSmartEditor(deps);

    expect(ndGetSmartPlaylistMock).not.toHaveBeenCalled();
    expect(deps.setCreatingSmart).not.toHaveBeenCalled();
  });

  it('opens the editor before the native rules fetch resolves', async () => {
    let resolveGet: ((value: unknown) => void) | undefined;
    ndGetSmartPlaylistMock.mockReturnValue(new Promise(resolve => {
      resolveGet = resolve;
    }));
    const deps = makeDeps({ name: 'Feishin mix', smart: true });
    const pending = runPlaylistsOpenSmartEditor(deps);

    expect(deps.setCreatingSmart).toHaveBeenCalledWith(true);
    expect(deps.setEditingSmartId).toHaveBeenCalledWith('playlist-1');
    expect(deps.setSmartSession).toHaveBeenCalled();

    resolveGet?.({
      id: 'playlist-1',
      name: 'Feishin mix',
      rules: { all: [{ contains: { title: 'live' } }] },
    });
    await pending;
    expect(deps.setCreatingSmart).toHaveBeenLastCalledWith(true);
  });

  it('opens an unprefixed playlist with valid native rules in Basic when they project', async () => {
    const deps = makeDeps({ name: 'Feishin mix', smart: true });
    ndGetSmartPlaylistMock.mockResolvedValue({
      id: 'playlist-1',
      name: 'Feishin mix',
      rules: {
        all: [{ inTheRange: { year: [1950, 2026] } }],
        limit: 25,
        sort: '+random',
      },
    });

    await runPlaylistsOpenSmartEditor(deps);

    expect(deps.setSmartFilters).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Feishin mix',
      limit: '25',
    }));
    expect(deps.setSmartSession).toHaveBeenCalledWith(expect.objectContaining({ mode: 'basic' }));
    expect(deps.setEditingSmartId).toHaveBeenCalledWith('playlist-1');
    expect(deps.setCreatingSmart).toHaveBeenCalledWith(true);
  });

  it('keeps list metadata when the native rules response omits it', async () => {
    const deps = makeDeps({
      name: 'Commented mix',
      smart: true,
      comment: 'Existing Navidrome comment',
      public: true,
      owner: 'jalen',
    });
    ndGetSmartPlaylistMock.mockResolvedValue({
      id: 'playlist-1',
      name: 'Commented mix',
      rules: { all: [{ contains: { title: 'live' } }] },
    });

    await runPlaylistsOpenSmartEditor(deps);

    expect(deps.setSmartSession).toHaveBeenNthCalledWith(1, expect.objectContaining({
      comment: 'Existing Navidrome comment',
      public: true,
      owner: 'jalen',
    }));
    expect(deps.setSmartSession).toHaveBeenLastCalledWith(expect.objectContaining({
      comment: 'Existing Navidrome comment',
      public: true,
      owner: 'jalen',
    }));
  });

  it('opens nested rules in Advanced instead of projecting them', async () => {
    const deps = makeDeps({ name: 'Feishin mix', smart: true });
    ndGetSmartPlaylistMock.mockResolvedValue({
      id: 'playlist-1',
      name: 'Feishin mix',
      rules: { any: [{ contains: { title: 'live' } }, { all: [{ contains: { artist: 'A' } }] }] },
    });

    await runPlaylistsOpenSmartEditor(deps);

    expect(deps.setSmartSession).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'advanced',
    }));
    expect(deps.setCreatingSmart).toHaveBeenCalledWith(true);
  });

  it('treats a successful native response without valid rules as authoritative', async () => {
    const deps = makeDeps({ name: 'psy-smart-Regular' });
    ndGetSmartPlaylistMock.mockResolvedValue({
      id: 'playlist-1',
      name: 'psy-smart-Regular',
      rules: { limit: 25 },
    });

    await runPlaylistsOpenSmartEditor(deps);

    expect(deps.setCreatingSmart).toHaveBeenCalledWith(true);
    expect(deps.setCreatingSmart).toHaveBeenLastCalledWith(false);
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('uses the legacy prefix when native metadata is unavailable', async () => {
    const deps = makeDeps({ name: 'psy-smart-Legacy' });
    ndGetSmartPlaylistMock.mockRejectedValue(new Error('unavailable'));
    ndListPlaylistsMock.mockRejectedValue(new Error('unavailable'));

    await runPlaylistsOpenSmartEditor(deps);

    expect(deps.setSmartFilters).toHaveBeenCalledWith(expect.objectContaining({ name: 'Legacy' }));
    expect(deps.setEditingSmartId).toHaveBeenCalledWith('playlist-1');
    expect(deps.setCreatingSmart).toHaveBeenCalledWith(true);
    expect(showToastMock).toHaveBeenCalled();
  });
});
