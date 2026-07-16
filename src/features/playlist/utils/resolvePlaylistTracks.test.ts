import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePlaylistTracks } from '@/features/playlist/utils/resolvePlaylistTracks';

const offlineMock = vi.fn(() => false);
const resolveServerMock = vi.fn((id: string | null | undefined) => id ?? undefined);
const resolvePlaylistMock = vi.fn();
const filterMock = vi.fn();
const serverFilterMock = vi.fn();
let activeServerId: string | null = 'srv-1';

vi.mock('@/features/offline', () => ({
  isOfflineBrowseActive: () => offlineMock(),
  resolveMediaServerId: (id: string | null | undefined) => resolveServerMock(id),
  resolvePlaylist: (serverId: string, playlistId: string) => resolvePlaylistMock(serverId, playlistId),
}));

vi.mock('@/lib/api/subsonicLibrary', () => ({
  filterSongsToActiveLibrary: (songs: unknown) => filterMock(songs),
  filterSongsToServerLibrary: (songs: unknown, serverId: string) => serverFilterMock(songs, serverId),
}));

vi.mock('@/lib/media/songToTrack', () => ({
  songToTrack: (song: { id: string }) => ({ id: song.id, track: true }),
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: { getState: () => ({ activeServerId }) },
}));

describe('resolvePlaylistTracks', () => {
  beforeEach(() => {
    offlineMock.mockReset().mockReturnValue(false);
    resolveServerMock.mockReset().mockImplementation((id: string | null | undefined) => id ?? undefined);
    resolvePlaylistMock.mockReset();
    filterMock.mockReset();
    serverFilterMock.mockReset();
    activeServerId = 'srv-1';
  });

  it('scopes to the active library when online', async () => {
    resolvePlaylistMock.mockResolvedValue({ playlist: { id: 'pl-1' }, songs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    // Active-library scope hides b and c.
    filterMock.mockResolvedValue([{ id: 'a' }]);

    const tracks = await resolvePlaylistTracks('pl-1');

    expect(filterMock).toHaveBeenCalledOnce();
    expect(tracks).toEqual([{ id: 'a', track: true }]);
  });

  it('uses the full offline list without library filtering', async () => {
    offlineMock.mockReturnValue(true);
    resolvePlaylistMock.mockResolvedValue({ playlist: { id: 'pl-1' }, songs: [{ id: 'a' }, { id: 'b' }] });

    const tracks = await resolvePlaylistTracks('pl-1');

    expect(filterMock).not.toHaveBeenCalled();
    expect(serverFilterMock).not.toHaveBeenCalled();
    expect(tracks).toEqual([{ id: 'a', track: true }, { id: 'b', track: true }]);
  });

  it('scopes a remote playlist to its owner server library', async () => {
    resolvePlaylistMock.mockResolvedValue({ playlist: { id: 'pl-1' }, songs: [{ id: 'a' }, { id: 'b' }] });
    serverFilterMock.mockResolvedValue([{ id: 'b' }]);

    const tracks = await resolvePlaylistTracks('pl-1', 'srv-2');

    expect(serverFilterMock).toHaveBeenCalledWith([{ id: 'a' }, { id: 'b' }], 'srv-2');
    expect(filterMock).not.toHaveBeenCalled();
    expect(tracks).toEqual([{ id: 'b', track: true, serverId: 'srv-2' }]);
  });

  it('returns [] when the active server cannot be resolved', async () => {
    activeServerId = null;
    resolveServerMock.mockReturnValue(undefined);

    const tracks = await resolvePlaylistTracks('pl-1');

    expect(tracks).toEqual([]);
    expect(resolvePlaylistMock).not.toHaveBeenCalled();
  });

  it('returns [] when the playlist cannot be resolved', async () => {
    resolvePlaylistMock.mockResolvedValue(null);

    const tracks = await resolvePlaylistTracks('pl-1');

    expect(tracks).toEqual([]);
    expect(filterMock).not.toHaveBeenCalled();
  });

  it('swallows a rejecting library-scope filter to [] (no unhandled rejection)', async () => {
    resolvePlaylistMock.mockResolvedValue({ playlist: { id: 'pl-1' }, songs: [{ id: 'a' }] });
    filterMock.mockRejectedValue(new Error('network'));

    await expect(resolvePlaylistTracks('pl-1')).resolves.toEqual([]);
  });
});
