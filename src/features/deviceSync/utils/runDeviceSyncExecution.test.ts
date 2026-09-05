import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeMock, onInvoke } from '@/test/mocks/tauri';
import { makeAuthState, makeServer } from '@/test/helpers/factories';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { useAuthStore } from '@/store/authStore';
import { serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import { useDeviceSyncStore, type DeviceSyncSource } from '@/features/deviceSync/store/deviceSyncStore';
import { useDeviceSyncJobStore } from '@/features/deviceSync/store/deviceSyncJobStore';
import { runDeviceSyncExecute, runDeviceSyncSummaryPrompt, type SyncDelta } from './runDeviceSyncExecution';

describe('runDeviceSyncSummaryPrompt ownership', () => {
  beforeEach(() => {
    resetAuthStore();
    useDeviceSyncStore.setState({
      targetDir: null,
      sources: [],
      checkedIds: [],
      pendingDeletion: [],
      pendingPlan: false,
      targetDeviceId: null,
      pendingPlanDeviceId: null,
      pendingPlanChecked: false,
      deviceFilePaths: [],
      scanning: false,
    });
    useDeviceSyncJobStore.getState().reset();
  });

  it('uses the captured source owner even when another server is active', async () => {
    const owner = makeServer({ id: 'owner', url: 'https://owner.test', username: 'alice', password: 'secret' });
    const active = makeServer({ id: 'active', url: 'https://active.test' });
    const serverIndexKey = serverIndexKeyForProfile(owner);
    const source: DeviceSyncSource = {
      type: 'album', id: 'album-1', name: 'Album', serverIndexKey,
    };
    useAuthStore.setState(makeAuthState({ servers: [owner, active], activeServerId: active.id }));
    useDeviceSyncStore.setState({
      targetDir: '/device', sources: [source], pendingDeletion: [], pendingPlanChecked: true,
    });

    onInvoke('calculate_sync_payload', args => {
      const payload = args as {
        sources: DeviceSyncSource[];
        auth: { serverId: string; serverIndexKey: string; baseUrl: string; u: string };
        layoutMode: string;
        playlistPathMode: string;
        expectedDeviceId: string | null;
      };
      expect(payload.sources).toEqual([source]);
      expect(payload.auth).toMatchObject({
        serverId: owner.id,
        serverIndexKey,
        baseUrl: 'https://owner.test/rest',
        u: 'alice',
      });
      expect(payload.layoutMode).toBe('self-contained');
      expect(payload.playlistPathMode).toBe('playlist-relative');
      expect(payload.expectedDeviceId).toBeNull();
      return {
        planId: 'plan-1',
        deviceId: 'device-1',
        addBytes: 0, addCount: 0, delBytes: 0, delCount: 0, reclaimableBytes: 0,
        availableBytes: 1, tracks: [], deletePaths: ['/device/old.flac'],
        deferredDeletePaths: ['/device/old.m3u8'],
        playlists: [], manifestFiles: [], manifestPlaylists: [],
      };
    });

    const setSyncDelta = vi.fn<(delta: SyncDelta) => void>();
    await runDeviceSyncSummaryPrompt({
      targetDir: '/device',
      sources: [source],
      pendingDeletion: [],
      layoutMode: 'self-contained',
      playlistPathMode: 'playlist-relative',
      t: ((key: string) => key) as never,
      setPreSyncLoading: vi.fn(),
      setPreSyncOpen: vi.fn(),
      setSyncDelta,
    });

    expect(setSyncDelta).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        serverIndexKey,
        planId: 'plan-1',
        deviceId: 'device-1',
        targetDir: '/device',
        sources: [source],
        deferredDeletePaths: ['/device/old.flac', '/device/old.m3u8'],
      }),
    }));
    expect(useDeviceSyncStore.getState().targetDeviceId).toBe('device-1');
  });

  it('discards a preview that resolves after the target changes', async () => {
    const owner = makeServer({ id: 'owner', url: 'https://owner.test' });
    const serverIndexKey = serverIndexKeyForProfile(owner);
    const source: DeviceSyncSource = {
      type: 'playlist', id: 'playlist-1', name: 'Playlist', serverIndexKey,
    };
    useAuthStore.setState(makeAuthState({ servers: [owner], activeServerId: owner.id }));
    useDeviceSyncStore.setState({
      targetDir: '/old', sources: [source], pendingDeletion: [], pendingPlanChecked: true,
    });

    let resolvePayload!: (value: object) => void;
    onInvoke('calculate_sync_payload', () => new Promise(resolve => { resolvePayload = resolve; }));
    const setSyncDelta = vi.fn<(delta: SyncDelta) => void>();
    const setPreSyncOpen = vi.fn<(open: boolean) => void>();
    const pending = runDeviceSyncSummaryPrompt({
      targetDir: '/old',
      sources: [source],
      pendingDeletion: [],
      layoutMode: 'self-contained',
      playlistPathMode: 'playlist-relative',
      t: ((key: string) => key) as never,
      setPreSyncLoading: vi.fn(),
      setPreSyncOpen,
      setSyncDelta,
    });

    useDeviceSyncStore.setState({ targetDir: '/new' });
    resolvePayload({
      planId: 'plan-1',
      deviceId: 'device-1',
      addBytes: 0, addCount: 0, delBytes: 0, delCount: 0, reclaimableBytes: 0,
      availableBytes: 1, tracks: [], deletePaths: [], deferredDeletePaths: [],
      playlists: [], manifestFiles: [], manifestPlaylists: [],
    });
    await pending;

    expect(setSyncDelta).not.toHaveBeenCalled();
    expect(setPreSyncOpen).toHaveBeenLastCalledWith(false);
  });

  it('refuses to calculate until the selected device plan state is checked', async () => {
    const owner = makeServer({ id: 'owner', url: 'https://owner.test' });
    const serverIndexKey = serverIndexKeyForProfile(owner);
    const source: DeviceSyncSource = {
      type: 'album', id: 'album-1', name: 'Album', serverIndexKey,
    };
    useAuthStore.setState(makeAuthState({ servers: [owner], activeServerId: owner.id }));
    useDeviceSyncStore.setState({ targetDir: '/device', sources: [source], pendingPlanChecked: false });
    const setSyncDelta = vi.fn<(delta: SyncDelta) => void>();

    await runDeviceSyncSummaryPrompt({
      targetDir: '/device',
      sources: [source],
      pendingDeletion: [],
      layoutMode: 'self-contained',
      playlistPathMode: 'playlist-relative',
      t: ((key: string) => key) as never,
      setPreSyncLoading: vi.fn(),
      setPreSyncOpen: vi.fn(),
      setSyncDelta,
    });

    expect(setSyncDelta).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith('calculate_sync_payload', expect.anything());
  });

  it('refuses to execute a preview after its source selection changes', async () => {
    const owner = makeServer({ id: 'owner', url: 'https://owner.test' });
    const serverIndexKey = serverIndexKeyForProfile(owner);
    const source: DeviceSyncSource = {
      type: 'album', id: 'album-1', name: 'Album', serverIndexKey,
    };
    useAuthStore.setState(makeAuthState({ servers: [owner], activeServerId: owner.id }));
    useDeviceSyncStore.setState({ targetDir: '/device', sources: [source], pendingDeletion: [] });
    const context = {
      targetDir: '/device',
      deviceId: 'device-1',
      planId: 'plan-1',
      serverIndexKey,
      sources: [source],
      deletionSourceKeys: [],
      layoutMode: 'self-contained' as const,
      playlistPathMode: 'playlist-relative' as const,
      deferredDeletePaths: [],
      playlists: [],
      manifestFiles: [],
      manifestPlaylists: [],
    };
    useDeviceSyncStore.setState({ sources: [] });
    const setPreSyncOpen = vi.fn<(open: boolean) => void>();

    await runDeviceSyncExecute({
      syncDelta: {
        planId: 'plan-1',
        deviceId: 'device-1',
        addBytes: 0, addCount: 0, delBytes: 0, delCount: 0, reclaimableBytes: 0,
        availableBytes: 1, tracks: [], deletePaths: [], deferredDeletePaths: [],
        playlists: [], manifestFiles: [], manifestPlaylists: [], context,
      },
      t: ((key: string) => key) as never,
      setPreSyncOpen,
      scanDevice: vi.fn(),
    });

    expect(setPreSyncOpen).toHaveBeenCalledWith(false);
    expect(useDeviceSyncJobStore.getState().status).toBe('idle');
    expect(invokeMock).not.toHaveBeenCalledWith('sync_batch_to_device', expect.anything());
  });
});
