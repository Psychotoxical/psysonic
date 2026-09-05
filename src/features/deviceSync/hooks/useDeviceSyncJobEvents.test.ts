import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  emitTauriEvent,
  invokeMock,
  onInvoke,
  tauriMockListenerCount,
} from '@/test/mocks/tauri';
import { useDeviceSyncJobStore } from '@/features/deviceSync/store/deviceSyncJobStore';
import { useDeviceSyncStore, type DeviceSyncSource } from '@/features/deviceSync/store/deviceSyncStore';
import { useDeviceSyncJobEvents } from './useDeviceSyncJobEvents';
import { NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY } from '@/lib/server/navidromeCanonicalCheckpointStatus';

const jobContext = (source: DeviceSyncSource, targetDir: string) => ({
  targetDir,
  deviceId: 'device-1',
  planId: 'plan-1',
  serverIndexKey: source.serverIndexKey,
  sources: [source],
  deletionSourceKeys: [],
  layoutMode: 'self-contained' as const,
  playlistPathMode: 'playlist-relative' as const,
  deferredDeletePaths: [],
  playlists: [],
  manifestFiles: [],
  manifestPlaylists: [],
});

describe('useDeviceSyncJobEvents ownership', () => {
  beforeEach(() => {
    useDeviceSyncJobStore.getState().reset();
    useDeviceSyncStore.setState({
      targetDir: null,
      sources: [],
      legacySources: [],
      legacyTargetDir: null,
      checkedIds: [],
      pendingDeletion: [],
      deviceFilePaths: [],
      scanning: false,
    });
  });

  it('writes completion metadata from the immutable job context', async () => {
    const source: DeviceSyncSource = {
      type: 'album',
      id: 'album-1',
      name: 'Album',
      serverIndexKey: 'owner.test',
    };
    useDeviceSyncJobStore.getState().startSync('job-1', 1, jobContext(source, '/old-device'));
    useDeviceSyncStore.setState({ targetDir: '/new-device', sources: [] });
    onInvoke('finalize_device_sync', () => ({ deleted: 0, cleanupFailed: false }));
    renderHook(() => useDeviceSyncJobEvents());
    await waitFor(() => expect(tauriMockListenerCount('device:sync:complete')).toBe(1));

    emitTauriEvent('device:sync:complete', {
      jobId: 'job-1', done: 1, skipped: 0, failed: 0, total: 1,
    });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('finalize_device_sync', expect.objectContaining({
      destDir: '/old-device',
      payload: expect.objectContaining({
        expectedDeviceId: 'device-1',
        ownerServerIndexKey: 'owner.test',
        sources: [expect.objectContaining(source)],
      }),
    })));
    expect(invokeMock).not.toHaveBeenCalledWith('list_device_dir_files', expect.anything());
  });

  it('does not write completion metadata after migration locks the window', async () => {
    const source: DeviceSyncSource = {
      type: 'album', id: 'album-1', name: 'Album', serverIndexKey: 'owner.test',
    };
    useDeviceSyncJobStore.getState().startSync('job-1', 1, jobContext(source, '/device'));
    localStorage.setItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY, '1');

    renderHook(() => useDeviceSyncJobEvents());
    await waitFor(() => expect(tauriMockListenerCount('device:sync:complete')).toBe(1));
    emitTauriEvent('device:sync:complete', {
      jobId: 'job-1', done: 1, skipped: 0, failed: 0, total: 1,
    });

    await waitFor(() => expect(useDeviceSyncJobStore.getState().status).toBe('failed'));
    expect(invokeMock).not.toHaveBeenCalledWith('finalize_device_sync', expect.anything());
  });

  it('keeps cancellation active until the native completion event confirms it', async () => {
    const source: DeviceSyncSource = {
      type: 'album', id: 'album-1', name: 'Album', serverIndexKey: 'owner.test',
    };
    useDeviceSyncJobStore.getState().startSync('job-1', 2, jobContext(source, '/device'));
    useDeviceSyncJobStore.getState().requestCancel();

    renderHook(() => useDeviceSyncJobEvents());
    await waitFor(() => expect(tauriMockListenerCount('device:sync:complete')).toBe(1));
    expect(useDeviceSyncJobStore.getState().status).toBe('cancelling');

    emitTauriEvent('device:sync:complete', {
      jobId: 'job-1', done: 1, skipped: 0, failed: 0, total: 2, cancelled: true,
    });

    await waitFor(() => expect(useDeviceSyncJobStore.getState()).toMatchObject({
      status: 'cancelled', done: 1, skipped: 0, failed: 0,
    }));
  });
});
