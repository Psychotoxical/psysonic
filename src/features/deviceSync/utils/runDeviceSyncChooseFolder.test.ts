import { beforeEach, describe, expect, it, vi } from 'vitest';
import { open } from '@tauri-apps/plugin-dialog';
import { invokeMock, onInvoke } from '@/test/mocks/tauri';
import { useDeviceSyncStore, type DeviceSyncSource } from '@/features/deviceSync/store/deviceSyncStore';
import { runDeviceSyncChooseFolder } from './runDeviceSyncChooseFolder';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));

describe('runDeviceSyncChooseFolder', () => {
  beforeEach(() => {
    vi.mocked(open).mockResolvedValue('/device');
    useDeviceSyncStore.setState({
      targetDir: null,
      layoutMode: 'self-contained',
      playlistPathMode: 'playlist-relative',
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

  it('restores layout configuration and materialized ownership from the manifest', async () => {
    const source: DeviceSyncSource = {
      type: 'playlist', id: 'playlist-1', name: 'Mix', serverIndexKey: 'owner.test',
    };
    const files = [{
      trackId: 'track-1',
      relativePath: 'Artist/Album/01 - Song.flac',
      sourceKeys: [JSON.stringify(['owner.test', 'playlist', 'playlist-1'])],
      sizeBytes: 100,
    }];
    onInvoke('read_device_manifest', () => ({
      version: 4,
      schema: 'fixed-v2',
      ownerServerIndexKey: 'owner.test',
      sources: [source],
      layoutMode: 'shared-album-tree',
      playlistPathMode: 'device-rooted',
      files,
      playlists: [],
    }));
    onInvoke('write_device_manifest', () => undefined);
    const setTargetDir = vi.fn((dir: string) => useDeviceSyncStore.getState().setTargetDir(dir));

    await runDeviceSyncChooseFolder({
      t: ((key: string) => key) as never,
      setTargetDir,
      scanDevice: vi.fn(),
    });

    expect(useDeviceSyncStore.getState()).toMatchObject({
      targetDir: '/device',
      layoutMode: 'shared-album-tree',
      playlistPathMode: 'device-rooted',
      syncedLayoutMode: 'shared-album-tree',
      syncedPlaylistPathMode: 'device-rooted',
      sources: [source],
    });
    expect(invokeMock).toHaveBeenCalledWith('write_device_manifest', expect.objectContaining({
      destDir: '/device',
      layoutMode: 'shared-album-tree',
      playlistPathMode: 'device-rooted',
      files,
    }));
  });
});
