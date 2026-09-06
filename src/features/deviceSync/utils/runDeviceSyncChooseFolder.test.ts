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
      pendingPlan: false,
      targetDeviceId: null,
      pendingPlanDeviceId: null,
      pendingPlanChecked: false,
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
    onInvoke('pending_device_sync_plan_device_id', () => null);
    onInvoke('device_sync_device_id', () => 'device-1');
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
    expect(invokeMock).not.toHaveBeenCalledWith('write_device_manifest', expect.anything());
  });

  it('preserves desired state when the selected folder has an active plan', async () => {
    const desired: DeviceSyncSource = {
      type: 'playlist', id: 'desired', name: 'Desired', serverIndexKey: 'owner.test',
    };
    useDeviceSyncStore.setState({
      sources: [desired],
      pendingDeletion: ['pending-key'],
      targetDeviceId: 'device-1',
    });
    onInvoke('read_device_manifest', () => ({
      version: 4,
      schema: 'fixed-v2',
      ownerServerIndexKey: 'owner.test',
      sources: [{ type: 'playlist', id: 'old', name: 'Old', serverIndexKey: 'owner.test' }],
      files: [],
      playlists: [],
    }));
    onInvoke('pending_device_sync_plan_device_id', () => 'device-1');
    onInvoke('device_sync_device_id', () => 'device-1');

    await runDeviceSyncChooseFolder({
      t: ((key: string) => key) as never,
      setTargetDir: dir => useDeviceSyncStore.getState().setTargetDir(dir),
      scanDevice: vi.fn(),
    });

    expect(useDeviceSyncStore.getState()).toMatchObject({
      targetDir: '/device',
      sources: [desired],
      pendingDeletion: ['pending-key'],
      pendingPlan: true,
      pendingPlanDeviceId: 'device-1',
      pendingPlanChecked: true,
      targetDeviceId: 'device-1',
    });
  });
});
