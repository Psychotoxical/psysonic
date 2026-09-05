import { beforeEach, describe, expect, it } from 'vitest';
import { invokeMock, onInvoke } from '@/test/mocks/tauri';
import { makeSubsonicSong } from '@/test/helpers/factories';
import {
  deviceSyncSourceKey,
  useDeviceSyncStore,
  type DeviceSyncSource,
} from '@/features/deviceSync/store/deviceSyncStore';
import type { DeviceSyncJobContext } from '@/features/deviceSync/store/deviceSyncJobStore';
import { finalizeDeviceSyncJob } from './finalizeDeviceSyncJob';

describe('finalizeDeviceSyncJob', () => {
  beforeEach(() => {
    useDeviceSyncStore.setState({
      targetDir: '/device',
      layoutMode: 'shared-album-tree',
      playlistPathMode: 'device-rooted',
      syncedLayoutMode: 'self-contained',
      syncedPlaylistPathMode: 'playlist-relative',
      sources: [],
      legacySources: [],
      legacyTargetDir: null,
      checkedIds: [],
      pendingDeletion: [],
      deviceFilePaths: [],
      scanning: false,
    });
  });

  it('commits playlists, deferred cleanup, manifest, and source removal in order', async () => {
    const album: DeviceSyncSource = {
      type: 'album', id: 'album-1', name: 'Album', serverIndexKey: 'server.test',
    };
    const playlist: DeviceSyncSource = {
      type: 'playlist', id: 'playlist-1', name: 'Mix', serverIndexKey: 'server.test',
    };
    const albumKey = deviceSyncSourceKey(album);
    useDeviceSyncStore.setState({ sources: [album, playlist], pendingDeletion: [albumKey] });
    onInvoke('delete_device_files', () => 1);
    onInvoke('write_playlist_m3u8', () => undefined);
    onInvoke('write_device_manifest', () => undefined);
    const track = makeSubsonicSong({ id: 'track-1', albumArtist: 'Album Artist', track: 1 });
    const context: DeviceSyncJobContext = {
      targetDir: '/device',
      serverIndexKey: 'server.test',
      sources: [playlist],
      deletionSourceKeys: [albumKey],
      layoutMode: 'shared-album-tree',
      playlistPathMode: 'device-rooted',
      deferredDeletePaths: ['/device/Playlists/Mix/01 - Track.flac'],
      playlists: [{
        sourceKey: deviceSyncSourceKey(playlist),
        name: 'Mix',
        relativePath: 'Playlists/Mix/Mix.m3u8',
        tracks: [track],
        references: ['/Album Artist/Test Album/01 - Song.flac'],
      }],
      manifestFiles: [{
        trackId: track.id,
        relativePath: 'Album Artist/Test Album/01 - Song.flac',
        sourceKeys: [deviceSyncSourceKey(playlist)],
        sizeBytes: track.size ?? 0,
      }],
      manifestPlaylists: [{
        sourceKey: deviceSyncSourceKey(playlist),
        relativePath: 'Playlists/Mix/Mix.m3u8',
      }],
    };

    await finalizeDeviceSyncJob(context);

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      'write_playlist_m3u8',
      'delete_device_files',
      'write_device_manifest',
    ]);
    expect(invokeMock).toHaveBeenCalledWith('write_playlist_m3u8', expect.objectContaining({
      references: ['/Album Artist/Test Album/01 - Song.flac'],
    }));
    expect(invokeMock).toHaveBeenCalledWith('delete_device_files', {
      destDir: '/device',
      paths: ['/device/Playlists/Mix/01 - Track.flac'],
    });
    expect(useDeviceSyncStore.getState().sources).toEqual([playlist]);
    expect(useDeviceSyncStore.getState().pendingDeletion).toEqual([]);
    expect(useDeviceSyncStore.getState().syncedLayoutMode).toBe('shared-album-tree');
    expect(useDeviceSyncStore.getState().syncedPlaylistPathMode).toBe('device-rooted');
  });

  it('does not commit manifest or source state when playlist writing fails', async () => {
    const playlist: DeviceSyncSource = {
      type: 'playlist', id: 'playlist-1', name: 'Mix', serverIndexKey: 'server.test',
    };
    useDeviceSyncStore.setState({ sources: [playlist] });
    onInvoke('write_playlist_m3u8', () => { throw 'read only'; });
    onInvoke('write_device_manifest', () => undefined);
    const context: DeviceSyncJobContext = {
      targetDir: '/device',
      serverIndexKey: 'server.test',
      sources: [playlist],
      deletionSourceKeys: [],
      layoutMode: 'shared-album-tree',
      playlistPathMode: 'device-rooted',
      deferredDeletePaths: ['/device/Playlists/Mix/01 - Track.flac'],
      playlists: [{
        sourceKey: deviceSyncSourceKey(playlist),
        name: 'Mix',
        relativePath: 'Playlists/Mix/Mix.m3u8',
        tracks: [makeSubsonicSong()],
        references: ['/Artist/Album/01 - Song.flac'],
      }],
      manifestFiles: [],
      manifestPlaylists: [],
    };

    await expect(finalizeDeviceSyncJob(context)).rejects.toThrow('read only');

    expect(invokeMock).not.toHaveBeenCalledWith('delete_device_files', expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith('write_device_manifest', expect.anything());
    expect(useDeviceSyncStore.getState().syncedLayoutMode).toBe('self-contained');
  });
});
