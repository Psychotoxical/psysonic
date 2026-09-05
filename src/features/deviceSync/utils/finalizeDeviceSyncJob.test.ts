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
      pendingPlan: false,
      targetDeviceId: null,
      pendingPlanDeviceId: null,
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
    onInvoke('finalize_device_sync', () => ({ deleted: 1, cleanupFailed: false }));
    const track = makeSubsonicSong({ id: 'track-1', albumArtist: 'Album Artist', track: 1 });
    const context: DeviceSyncJobContext = {
      targetDir: '/device',
      deviceId: 'device-1',
      planId: 'plan-1',
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

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual(['finalize_device_sync']);
    expect(invokeMock).toHaveBeenCalledWith('finalize_device_sync', {
      destDir: '/device',
      payload: expect.objectContaining({
        expectedDeviceId: 'device-1',
        planId: 'plan-1',
        deferredDeletePaths: ['/device/Playlists/Mix/01 - Track.flac'],
        playlists: [expect.objectContaining({
          references: ['/Album Artist/Test Album/01 - Song.flac'],
        })],
      }),
    });
    expect(useDeviceSyncStore.getState().sources).toEqual([playlist]);
    expect(useDeviceSyncStore.getState().pendingDeletion).toEqual([]);
    expect(useDeviceSyncStore.getState().pendingPlan).toBe(false);
    expect(useDeviceSyncStore.getState().syncedLayoutMode).toBe('shared-album-tree');
    expect(useDeviceSyncStore.getState().syncedPlaylistPathMode).toBe('device-rooted');
  });

  it('does not commit source state when native finalization fails', async () => {
    const playlist: DeviceSyncSource = {
      type: 'playlist', id: 'playlist-1', name: 'Mix', serverIndexKey: 'server.test',
    };
    useDeviceSyncStore.setState({ sources: [playlist] });
    onInvoke('finalize_device_sync', () => { throw 'read only'; });
    const context: DeviceSyncJobContext = {
      targetDir: '/device',
      deviceId: 'device-1',
      planId: 'plan-1',
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

    expect(invokeMock).toHaveBeenCalledWith('finalize_device_sync', expect.anything());
    expect(useDeviceSyncStore.getState().syncedLayoutMode).toBe('self-contained');
  });

  it('keeps source state pending when native cleanup is incomplete', async () => {
    const playlist: DeviceSyncSource = {
      type: 'playlist', id: 'playlist-1', name: 'Mix', serverIndexKey: 'server.test',
    };
    const playlistKey = deviceSyncSourceKey(playlist);
    useDeviceSyncStore.setState({ sources: [playlist], pendingDeletion: [playlistKey] });
    onInvoke('finalize_device_sync', () => ({ deleted: 0, cleanupFailed: true }));
    const context: DeviceSyncJobContext = {
      targetDir: '/device',
      deviceId: 'device-1',
      planId: 'plan-1',
      serverIndexKey: 'server.test',
      sources: [],
      deletionSourceKeys: [playlistKey],
      layoutMode: 'shared-album-tree',
      playlistPathMode: 'device-rooted',
      deferredDeletePaths: ['/device/old.flac'],
      playlists: [],
      manifestFiles: [],
      manifestPlaylists: [],
    };

    await expect(finalizeDeviceSyncJob(context)).rejects.toThrow('DEVICE_SYNC_CLEANUP_FAILED');

    expect(useDeviceSyncStore.getState().sources).toEqual([playlist]);
    expect(useDeviceSyncStore.getState().pendingDeletion).toEqual([playlistKey]);
    expect(useDeviceSyncStore.getState().pendingPlan).toBe(true);
  });
});
