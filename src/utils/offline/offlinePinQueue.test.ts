import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelledDownloads, useOfflineJobStore } from '../../store/offlineJobStore';
import {
  clearOfflinePinTasks,
  dequeueOfflinePin,
  enqueueOfflinePin,
  isAlbumPinQueued,
  registerOfflinePinExecutor,
} from './offlinePinQueue';

describe('offlinePinQueue', () => {
  beforeEach(() => {
    cancelledDownloads.clear();
    clearOfflinePinTasks();
    useOfflineJobStore.setState({ jobs: [], pinQueue: [], bulkProgress: {} });
    registerOfflinePinExecutor(async () => {});
  });

  it('dequeues a queued album without affecting an active download', async () => {
    let release: (() => void) | null = null;
    registerOfflinePinExecutor(async () => {
      await new Promise<void>(resolve => {
        release = resolve;
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

    release?.();
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

  it('processes albums one after another', async () => {
    const order: string[] = [];
    let release: (() => void) | null = null;
    registerOfflinePinExecutor(async task => {
      order.push(task.albumId);
      await new Promise<void>(resolve => {
        release = resolve;
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

    release?.();
    await vi.waitFor(() => expect(order).toEqual(['alb-1', 'alb-2']));
  });
});
