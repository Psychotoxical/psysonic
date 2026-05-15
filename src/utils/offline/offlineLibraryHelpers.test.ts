import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../store/authStore';
import { switchActiveServer } from '../server/switchActiveServer';
import {
  buildOfflineTracksForAlbum,
  ensureServerForOfflineAlbum,
  hasAnyOfflineAlbums,
  offlineAlbumCoverArt,
  offlineTrackCount,
} from './offlineLibraryHelpers';
import type { OfflineAlbumMeta, OfflineTrackMeta } from '../../store/offlineStore';

vi.mock('../server/switchActiveServer', () => ({
  switchActiveServer: vi.fn(async () => true),
}));

describe('offlineLibraryHelpers', () => {
  beforeEach(() => {
    useAuthStore.setState({
      servers: [{ id: 'a', name: 'Home', url: 'http://a.test', username: 'u', password: 'p' }],
      activeServerId: 'a',
    });
  });

  it('hasAnyOfflineAlbums is true when any album exists', () => {
    expect(hasAnyOfflineAlbums({})).toBe(false);
    expect(hasAnyOfflineAlbums({
      'a:al1': { id: 'al1', serverId: 'a', name: 'X', artist: 'Y', trackIds: [] },
    })).toBe(true);
  });

  it('buildOfflineTracksForAlbum uses album serverId in track keys', () => {
    const album: OfflineAlbumMeta = {
      id: 'al1', serverId: 'a', name: 'Al', artist: 'Ar', trackIds: ['t1', 't2'],
    };
    const tracks: Record<string, OfflineTrackMeta> = {
      'a:t1': {
        id: 't1', serverId: 'a', localPath: '/x.flac', title: 'One', artist: 'Ar',
        album: 'Al', albumId: 'al1', suffix: 'flac', duration: 100, cachedAt: '2026-01-01',
      },
      'b:t2': {
        id: 't2', serverId: 'b', localPath: '/y.flac', title: 'Wrong', artist: 'Ar',
        album: 'Al', albumId: 'al1', suffix: 'flac', duration: 100, cachedAt: '2026-01-01',
      },
    };
    const built = buildOfflineTracksForAlbum(album, tracks);
    expect(built).toHaveLength(1);
    expect(built[0]?.title).toBe('One');
    expect(offlineTrackCount(album, tracks)).toBe(1);
  });

  it('offlineAlbumCoverArt returns empty when server profile is missing', () => {
    const album: OfflineAlbumMeta = {
      id: 'al1', serverId: 'gone', name: 'Al', artist: 'Ar', coverArt: 'ca1', trackIds: [],
    };
    expect(offlineAlbumCoverArt(album, 300)).toEqual({ src: '', cacheKey: '' });
  });

  it('offlineAlbumCoverArt builds url when server exists', () => {
    const album: OfflineAlbumMeta = {
      id: 'al1', serverId: 'a', name: 'Al', artist: 'Ar', coverArt: 'ca1', trackIds: [],
    };
    const { src, cacheKey } = offlineAlbumCoverArt(album, 300);
    expect(src).toContain('ca1');
    expect(cacheKey).toBe('a:cover:ca1:300');
  });

  it('ensureServerForOfflineAlbum skips switch when already active', async () => {
    vi.mocked(switchActiveServer).mockClear();
    const album: OfflineAlbumMeta = {
      id: 'al1', serverId: 'a', name: 'Al', artist: 'Ar', trackIds: [],
    };
    await expect(ensureServerForOfflineAlbum(album)).resolves.toBe(true);
    expect(switchActiveServer).not.toHaveBeenCalled();
  });

  it('ensureServerForOfflineAlbum switches when album is on another server', async () => {
    useAuthStore.setState({
      servers: [
        { id: 'a', name: 'Home', url: 'http://a.test', username: 'u', password: 'p' },
        { id: 'b', name: 'Work', url: 'http://b.test', username: 'u', password: 'p' },
      ],
      activeServerId: 'b',
    });
    const album: OfflineAlbumMeta = {
      id: 'al1', serverId: 'a', name: 'Al', artist: 'Ar', trackIds: [],
    };
    await expect(ensureServerForOfflineAlbum(album)).resolves.toBe(true);
    expect(switchActiveServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a' }),
    );
  });
});
