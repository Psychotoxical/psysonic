import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePendingSmartPolling } from '@/features/playlist/hooks/usePendingSmartPolling';
import { usePlaylistStore } from '@/features/playlist/store/playlistStore';
import type { PendingSmartPlaylist } from '@/features/playlist/utils/playlistsSmart';

const { getPlaylistForServer } = vi.hoisted(() => ({ getPlaylistForServer: vi.fn() }));
vi.mock('@/lib/api/subsonicPlaylists', () => ({ getPlaylistForServer }));

describe('usePendingSmartPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    usePlaylistStore.setState({
      playlists: [
        { id: 'same', serverId: 's1', name: 'psy-smart-mix', songCount: 0, duration: 0, created: '', changed: '' },
        { id: 'same', serverId: 's2', name: 'psy-smart-mix', songCount: 0, duration: 0, created: '', changed: '' },
      ],
    });
    getPlaylistForServer.mockImplementation(async (serverId: string) => ({
      playlist: {
        id: 'same', serverId, name: 'psy-smart-mix', songCount: serverId === 's1' ? 1 : 2,
        duration: 0, coverArt: `cover-${serverId}`, created: '', changed: '',
      },
      songs: [],
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls and hydrates equal ids independently by owner server', async () => {
    const pending: PendingSmartPlaylist[] = [
      { serverId: 's1', id: 'same', name: 'psy-smart-mix', attempts: 0 },
      { serverId: 's2', id: 'same', name: 'psy-smart-mix', attempts: 0 },
    ];
    const setPendingSmart = vi.fn();
    const fetchPlaylists = vi.fn(async () => {});

    renderHook(() => usePendingSmartPolling(pending, setPendingSmart, fetchPlaylists));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(getPlaylistForServer).toHaveBeenCalledWith('s1', 'same');
    expect(getPlaylistForServer).toHaveBeenCalledWith('s2', 'same');
    expect(usePlaylistStore.getState().playlists).toEqual(expect.arrayContaining([
      expect.objectContaining({ serverId: 's1', id: 'same', songCount: 1, coverArt: 'cover-s1' }),
      expect.objectContaining({ serverId: 's2', id: 'same', songCount: 2, coverArt: 'cover-s2' }),
    ]));
  });
});
