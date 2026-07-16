import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import { usePlaylistSongMutations } from '@/features/playlist/hooks/usePlaylistSongMutations';
import { makeSubsonicSong } from '@/test/helpers/factories';

describe('usePlaylistSongMutations', () => {
  it('does not add a track hidden by the current library scope', () => {
    const savePlaylist = vi.fn().mockResolvedValue(undefined);
    const setSongs = vi.fn();
    const { result } = renderHook(() => usePlaylistSongMutations({
      songs: [makeSubsonicSong({ id: 'visible', title: 'Visible' })],
      setSongs,
      savePlaylist,
      setSuggestions: vi.fn(),
      setSearchResults: vi.fn(),
      playlist: { id: 'pl-1', name: 'Playlist', songCount: 2, duration: 360, created: '', changed: '' },
      t: ((key: string) => key) as TFunction,
      hasSong: id => id === 'hidden',
    }));

    result.current.addSong(makeSubsonicSong({ id: 'hidden', title: 'Hidden' }));

    expect(setSongs).not.toHaveBeenCalled();
    expect(savePlaylist).not.toHaveBeenCalled();
  });
});
