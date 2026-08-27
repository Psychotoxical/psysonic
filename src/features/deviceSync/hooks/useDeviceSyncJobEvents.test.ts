import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    useDeviceSyncJobStore.getState().startSync('job-1', 1, {
      targetDir: '/old-device',
      serverIndexKey: source.serverIndexKey,
      sources: [source],
    });
    useDeviceSyncStore.setState({ targetDir: '/new-device', sources: [] });
    onInvoke('write_device_manifest', () => undefined);
    const scanDevice = vi.fn(async () => undefined);

    renderHook(() => useDeviceSyncJobEvents(((key: string) => key) as never, scanDevice));
    await waitFor(() => expect(tauriMockListenerCount('device:sync:complete')).toBe(1));

    emitTauriEvent('device:sync:complete', {
      jobId: 'job-1', done: 1, skipped: 0, failed: 0, total: 1,
    });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('write_device_manifest', {
      destDir: '/old-device',
      ownerServerIndexKey: 'owner.test',
      sources: [source],
      canonicalIdVersion: null,
    }));
    expect(scanDevice).not.toHaveBeenCalled();
  });

  it('does not write completion metadata after migration locks the window', async () => {
    const source: DeviceSyncSource = {
      type: 'album', id: 'album-1', name: 'Album', serverIndexKey: 'owner.test',
    };
    useDeviceSyncJobStore.getState().startSync('job-1', 1, {
      targetDir: '/device', serverIndexKey: source.serverIndexKey, sources: [source],
    });
    localStorage.setItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY, '1');

    renderHook(() => useDeviceSyncJobEvents(((key: string) => key) as never, vi.fn()));
    await waitFor(() => expect(tauriMockListenerCount('device:sync:complete')).toBe(1));
    emitTauriEvent('device:sync:complete', {
      jobId: 'job-1', done: 1, skipped: 0, failed: 0, total: 1,
    });

    await waitFor(() => expect(useDeviceSyncJobStore.getState().status).toBe('done'));
    expect(invokeMock).not.toHaveBeenCalledWith('write_device_manifest', expect.anything());
  });
});
