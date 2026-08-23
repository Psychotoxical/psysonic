import type { TFunction } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updatePlaylistMetaMock = vi.hoisted(() => vi.fn());
const ndUpdatePlaylistMetaMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/subsonicPlaylists', () => ({
  getPlaylist: vi.fn(),
  getPlaylistForServer: vi.fn(),
  updatePlaylistMeta: updatePlaylistMetaMock,
  uploadPlaylistCoverArt: vi.fn(),
}));
vi.mock('@/lib/api/navidromeSmart', () => ({
  ndUpdatePlaylistMeta: ndUpdatePlaylistMetaMock,
}));
vi.mock('@/lib/dom/toast', () => ({ showToast: vi.fn() }));

import { runPlaylistSaveMeta } from './runPlaylistSaveMeta';

function makeDeps(name: string, smart?: boolean) {
  return {
    id: 'pl-1',
    serverId: 'srv-a',
    playlist: {
      id: 'pl-1',
      name,
      smart,
      songCount: 0,
      duration: 0,
      created: '',
      changed: '',
      serverId: 'srv-a',
    },
    t: ((key: string) => key) as TFunction,
    setPlaylist: vi.fn(),
    setCustomCoverId: vi.fn(),
    setEditingMeta: vi.fn(),
  };
}

describe('runPlaylistSaveMeta', () => {
  beforeEach(() => {
    updatePlaylistMetaMock.mockReset().mockResolvedValue(undefined);
    ndUpdatePlaylistMetaMock.mockReset().mockResolvedValue(undefined);
  });

  it('updates smart metadata through a native partial PUT and leaves Subsonic unused', async () => {
    const deps = makeDeps('Feishin mix', true);
    await runPlaylistSaveMeta(deps, {
      name: 'Feishin mix',
      comment: 'Rules stay',
      isPublic: true,
      coverFile: null,
      coverRemoved: false,
    });

    expect(ndUpdatePlaylistMetaMock).toHaveBeenCalledWith(
      'pl-1',
      { name: 'Feishin mix', comment: 'Rules stay', public: true },
      'srv-a',
    );
    expect(updatePlaylistMetaMock).not.toHaveBeenCalled();
  });

  it('keeps regular playlists on the Subsonic metadata path', async () => {
    const deps = makeDeps('Manual mix', false);
    await runPlaylistSaveMeta(deps, {
      name: 'Manual mix',
      comment: '',
      isPublic: false,
      coverFile: null,
      coverRemoved: false,
    });

    expect(updatePlaylistMetaMock).toHaveBeenCalledWith('pl-1', 'Manual mix', '', false, 'srv-a');
    expect(ndUpdatePlaylistMetaMock).not.toHaveBeenCalled();
  });
});
