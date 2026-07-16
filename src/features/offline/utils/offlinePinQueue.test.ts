import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelledDownloads, useOfflineJobStore } from '@/features/offline/store/offlineJobStore';
import {
  clearOfflinePinTasks,
  dequeueOfflinePin,
  enqueueOfflinePin,
  isAlbumPinQueued,
  registerOfflinePinExecutor,
} from '@/features/offline/utils/offlinePinQueue';

describe('offlinePinQueue', () => {
  beforeEach(() => {
    cancelledDownloads.clear();
    clearOfflinePinTasks();
    useOfflineJobStore.setState({ jobs: [], pinQueue: [], bulkProgress: {} });
    registerOfflinePinExecutor(async () => {});
  });

  it('dequeues a queued album without affecting an active download', async () => {
    const gate = { unblock: undefined as (() => void) | undefined };
    registerOfflinePinExecutor(async () => {
      await new Promise<void>(resolve => {
        gate.unblock = () => resolve();
      });
    });

    enqueueOfflinePin({
      albumId: 'alb-1',
      albumName: 'One',
      albumArtist: 'A',
      coverArt: undefined,
      year: undefined,
      songs: [],
      serverId: 'srv',
      type: 'album',
    });
    enqueueOfflinePin({
      albumId: 'alb-2',
      albumName: 'Two',
      albumArtist: 'B',
      coverArt: undefined,
      year: undefined,
      songs: [],
      serverId: 'srv',
      type: 'album',
    });

    await vi.waitFor(() => expect(isAlbumPinQueued('alb-2')).toBe(true));
    expect(dequeueOfflinePin('alb-2')).toBe(true);
    expect(isAlbumPinQueued('alb-2')).toBe(false);
    expect(useOfflineJobStore.getState().pinQueue).toHaveLength(1);

    gate.unblock?.();
    await vi.waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toHaveLength(0));
  });

  it('allows re-enqueue after cancelDownload (e.g. remove offline cache)', async () => {
    const ran: string[] = [];
    registerOfflinePinExecutor(async task => {
      ran.push(task.albumId);
    });

    const task = {
      albumId: 'alb-1',
      albumName: 'One',
      albumArtist: 'A',
      coverArt: undefined,
      year: undefined,
      songs: [],
      serverId: 'srv',
      type: 'album' as const,
    };

    enqueueOfflinePin(task);
    await vi.waitFor(() => expect(ran).toEqual(['alb-1']));

    useOfflineJobStore.getState().cancelDownload('alb-1');
    expect(cancelledDownloads.has('alb-1')).toBe(true);

    enqueueOfflinePin(task);
    await vi.waitFor(() => expect(ran).toEqual(['alb-1', 'alb-1']));
  });

  it('clears stale cancel flag when enqueueOfflinePin runs', async () => {
    cancelledDownloads.add('alb-1');
    const ran: string[] = [];
    registerOfflinePinExecutor(async task => {
      ran.push(task.albumId);
    });

    enqueueOfflinePin({
      albumId: 'alb-1',
      albumName: 'One',
      albumArtist: 'A',
      coverArt: undefined,
      year: undefined,
      songs: [],
      serverId: 'srv',
      type: 'album',
    });

    await vi.waitFor(() => expect(ran).toEqual(['alb-1']));
    expect(cancelledDownloads.has('alb-1')).toBe(false);
  });

  it('dedupes duplicate album ids in the queue', () => {
    const task = {
      albumId: 'alb-1',
      albumName: 'One',
      albumArtist: 'A',
      coverArt: undefined,
      year: undefined,
      songs: [],
      serverId: 'srv',
      type: 'album' as const,
    };
    expect(enqueueOfflinePin(task)).toBe(true);
    expect(enqueueOfflinePin(task)).toBe(false);
    expect(useOfflineJobStore.getState().pinQueue).toHaveLength(1);
  });

  it('does not replace the in-flight task when a download is active', async () => {
    let capturedTrackIds: string[] = [];
    const gate = { unblock: undefined as (() => void) | undefined };
    registerOfflinePinExecutor(async task => {
      capturedTrackIds = task.songs.map(s => s.id);
      await new Promise<void>(resolve => {
        gate.unblock = () => resolve();
      });
    });

    const base = {
      albumId: 'alb-1',
      albumName: 'One',
      albumArtist: 'A',
      coverArt: undefined,
      year: undefined,
      serverId: 'srv',
      type: 'album' as const,
    };

    enqueueOfflinePin({ ...base, songs: [{ id: 't1', title: 't1', artist: 'A', album: 'Al', albumId: 'alb-1', duration: 1 }] });
    await vi.waitFor(() => {
      expect(useOfflineJobStore.getState().pinQueue[0]?.status).toBe('downloading');
    });

    expect(enqueueOfflinePin({
      ...base,
      songs: [
        { id: 't1', title: 't1', artist: 'A', album: 'Al', albumId: 'alb-1', duration: 1 },
        { id: 't2', title: 't2', artist: 'A', album: 'Al', albumId: 'alb-1', duration: 1 },
      ],
    })).toBe(false);

    gate.unblock?.();
    await vi.waitFor(() => expect(capturedTrackIds).toEqual(['t1']));
  });

  it('processes albums one after another', async () => {
    const order: string[] = [];
    const gate = { unblock: undefined as (() => void) | undefined };
    registerOfflinePinExecutor(async task => {
      order.push(task.albumId);
      await new Promise<void>(resolve => {
        gate.unblock = () => resolve();
      });
    });

    enqueueOfflinePin({
      albumId: 'alb-1',
      albumName: 'One',
      albumArtist: 'A',
      coverArt: undefined,
      year: undefined,
      songs: [],
      serverId: 'srv',
      type: 'album',
    });
    enqueueOfflinePin({
      albumId: 'alb-2',
      albumName: 'Two',
      albumArtist: 'B',
      coverArt: undefined,
      year: undefined,
      songs: [],
      serverId: 'srv',
      type: 'album',
    });

    await vi.waitFor(() => expect(order).toEqual(['alb-1']));
    expect(useOfflineJobStore.getState().pinQueue.some(p => p.albumId === 'alb-2' && p.status === 'queued')).toBe(true);

    gate.unblock?.();
    await vi.waitFor(() => expect(order).toEqual(['alb-1', 'alb-2']));
  });
});
