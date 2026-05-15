import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../store/authStore';
import {
  buildOfflineTracksForAlbum,
  hasAnyOfflineAlbums,
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
});
