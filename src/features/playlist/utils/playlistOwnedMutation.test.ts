import { beforeEach, describe, expect, it, vi } from 'vitest';

const deletePlaylistMock = vi.hoisted(() => vi.fn());
const ndDeletePlaylistMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/subsonicPlaylists', () => ({
  deletePlaylist: deletePlaylistMock,
}));
vi.mock('@/lib/api/navidromeSmart', () => ({
  ndDeletePlaylist: ndDeletePlaylistMock,
}));

import {
  deleteOwnedPlaylist,
  playlistsOpenSmartEditorState,
  readOpenSmartEditorIntent,
  resolvePlaylistPersistedName,
  shouldUseNativePlaylistMutation,
} from './playlistOwnedMutation';

describe('playlist owned mutation routing', () => {
  beforeEach(() => {
    deletePlaylistMock.mockReset().mockResolvedValue(undefined);
    ndDeletePlaylistMock.mockReset().mockResolvedValue(undefined);
  });

  it('routes smart deletes through the native API and regular deletes through Subsonic', async () => {
    await deleteOwnedPlaylist({ id: 'smart-1', name: 'Native', smart: true, serverId: 'srv-a' });
    await deleteOwnedPlaylist({ id: 'reg-1', name: 'Manual', smart: false, serverId: 'srv-a' });
    await deleteOwnedPlaylist({ id: 'legacy-1', name: 'psy-smart-Legacy', serverId: 'srv-a' });

    expect(ndDeletePlaylistMock).toHaveBeenCalledWith('smart-1', 'srv-a');
    expect(ndDeletePlaylistMock).toHaveBeenCalledWith('legacy-1', 'srv-a');
    expect(deletePlaylistMock).toHaveBeenCalledWith('reg-1', 'srv-a');
    expect(deletePlaylistMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a legacy prefixed name unless the visible title actually changed', () => {
    const playlist = { name: 'psy-smart-Road trip' };
    expect(resolvePlaylistPersistedName(playlist, 'Road trip')).toBe('psy-smart-Road trip');
    expect(resolvePlaylistPersistedName(playlist, '  Road trip  ')).toBe('psy-smart-Road trip');
    expect(resolvePlaylistPersistedName(playlist, 'Summer')).toBe('Summer');
  });

  it('exposes an Edit Rules navigation intent for smart playlists', () => {
    expect(shouldUseNativePlaylistMutation({ name: 'Native', smart: true })).toBe(true);
    expect(playlistsOpenSmartEditorState({ id: 'smart-1', name: 'Native', serverId: 'srv-a' })).toEqual({
      pathname: '/playlists',
      state: { openSmartEditorFor: { id: 'smart-1', serverId: 'srv-a', name: 'Native' } },
    });
    expect(readOpenSmartEditorIntent({
      openSmartEditorFor: { id: 'smart-1', serverId: 'srv-a', name: 'Native' },
    })).toEqual({ id: 'smart-1', serverId: 'srv-a', name: 'Native' });
    expect(readOpenSmartEditorIntent(null)).toBeNull();
  });
});
