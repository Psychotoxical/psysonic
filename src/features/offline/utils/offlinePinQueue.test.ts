import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelledDownloads, useOfflineJobStore } from '@/features/offline/store/offlineJobStore';
import {
  cancelAllOfflinePins,
  clearOfflinePinTasks,
  dequeueOfflinePin,
  enqueueOfflinePin,
  isAlbumPinQueued,
  registerOfflinePinExecutor,
  removeOfflinePinTask,
} from '@/features/offline/utils/offlinePinQueue';

describe('offlinePinQueue', () => {
  beforeEach(() => {
    cancelledDownloads.clear();
    clearOfflinePinTasks();
    useOfflineJobStore.setState({ jobs: [], pinQueue: [], bulkProgress: {} });
    registerOfflinePinExecutor(async (_task, markStarted) => {
      markStarted();
    });
  });

  it('dequeues a queued album without affecting an active download', async () => {
    const resolvers: Array<() => void> = [];
    registerOfflinePinExecutor(async (_task, markStarted) => {
      markStarted();
      await new Promise<void>(resolve => resolvers.push(resolve));
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
    enqueueOfflinePin({
      albumId: 'alb-3',
      albumName: 'Three',
      albumArtist: 'C',
      coverArt: undefined,
      year: undefined,
      songs: [],
      serverId: 'srv',
      type: 'album',
    });

    await vi.waitFor(() => expect(isAlbumPinQueued('alb-3')).toBe(true));
    expect(dequeueOfflinePin('alb-3')).toBe(true);
    expect(isAlbumPinQueued('alb-3')).toBe(false);
    expect(cancelledDownloads.has('srv:alb-3')).toBe(false);
    expect(useOfflineJobStore.getState().pinQueue).toHaveLength(2);

    resolvers.forEach(resolve => resolve());
    await vi.waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toHaveLength(0));
  });

  it('cancels a dispatched task that is still waiting to start a transfer', async () => {
    let releaseExecutor!: () => void;
    let markExecutorEntered!: () => void;
    const executorEntered = new Promise<void>(resolve => {
      markExecutorEntered = resolve;
    });
    registerOfflinePinExecutor(async (task) => {
      useOfflineJobStore.setState({
        jobs: [{
          trackId: 'track-1',
          albumId: task.albumId,
          albumName: task.albumName,
          trackTitle: 'Track',
          trackIndex: 0,
          totalTracks: 1,
          status: 'queued',
          downloadId: 'download-1',
          serverId: task.serverId,
          pinKind: task.type,
        }],
      });
      markExecutorEntered();
      await new Promise<void>(resolve => {
        releaseExecutor = resolve;
      });
      return cancelledDownloads.has(`${task.serverId}:${task.albumId}`)
        ? 'cancelled'
        : 'completed';
    });
    useOfflineJobStore.setState({ bulkProgress: { artist: { done: 0, total: 1 } } });
    enqueueOfflinePin({
      albumId: 'alb-1',
      albumName: 'One',
      albumArtist: 'A',
      coverArt: undefined,
      year: undefined,
      songs: [],
      serverId: 'srv',
      type: 'artist',
      artistProgressGroupId: 'artist',
    });
    await executorEntered;

    expect(dequeueOfflinePin('alb-1', 'srv')).toBe(true);
    expect(useOfflineJobStore.getState().jobs).toEqual([]);
    expect(useOfflineJobStore.getState().pinQueue).toEqual([]);
    expect(useOfflineJobStore.getState().bulkProgress.artist).toBeUndefined();

    releaseExecutor();
    await vi.waitFor(() => expect(cancelledDownloads.has('srv:alb-1')).toBe(false));
  });

  it('does not exceed the executor cap while cancelled executors settle', async () => {
    const started: string[] = [];
    const resolvers = new Map<string, () => void>();
    registerOfflinePinExecutor(async (task) => {
      started.push(task.albumId);
      await new Promise<void>(resolve => resolvers.set(task.albumId, resolve));
      return cancelledDownloads.has(`${task.serverId}:${task.albumId}`)
        ? 'cancelled'
        : 'completed';
    });
    const task = (albumId: string) => ({
      albumId,
      albumName: albumId,
      albumArtist: 'A',
      coverArt: undefined,
      year: undefined,
      songs: [],
      serverId: 'srv',
      type: 'album' as const,
    });
    enqueueOfflinePin(task('alb-1'));
    enqueueOfflinePin(task('alb-2'));
    enqueueOfflinePin(task('alb-3'));
    await vi.waitFor(() => expect(started).toEqual(['alb-1', 'alb-2']));

    expect(dequeueOfflinePin('alb-1', 'srv')).toBe(true);
    expect(dequeueOfflinePin('alb-2', 'srv')).toBe(true);
    await Promise.resolve();
    expect(started).toEqual(['alb-1', 'alb-2']);

    resolvers.get('alb-1')?.();
    await vi.waitFor(() => expect(started).toEqual(['alb-1', 'alb-2', 'alb-3']));
    resolvers.forEach(resolve => resolve());
    await vi.waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
  });

  it('does not retain cancel-all tombstones for undispatched tasks', async () => {
    const resolvers: Array<() => void> = [];
    registerOfflinePinExecutor(async () => {
      await new Promise<void>(resolve => resolvers.push(resolve));
      return 'cancelled';
    });
    const task = (albumId: string) => ({
      albumId,
      albumName: albumId,
      albumArtist: 'A',
      coverArt: undefined,
      year: undefined,
      songs: [],
      serverId: 'srv',
      type: 'album' as const,
    });
    enqueueOfflinePin(task('active-1'));
    enqueueOfflinePin(task('active-2'));
    enqueueOfflinePin(task('queued'));
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));

    cancelAllOfflinePins();

    expect(cancelledDownloads.has('srv:queued')).toBe(false);
    expect(cancelledDownloads.has('srv:active-1')).toBe(true);
    expect(cancelledDownloads.has('srv:active-2')).toBe(true);
    resolvers.forEach(resolve => resolve());
    await vi.waitFor(() => {
      expect(cancelledDownloads.has('srv:active-1')).toBe(false);
      expect(cancelledDownloads.has('srv:active-2')).toBe(false);
    });
  });

  it('allows re-enqueue after cancelDownload (e.g. remove offline cache)', async () => {
    const ran: string[] = [];
    registerOfflinePinExecutor(async (task, markStarted) => {
      markStarted();
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
    expect(cancelledDownloads.has('alb-1')).toBe(false);

    enqueueOfflinePin(task);
    await vi.waitFor(() => expect(ran).toEqual(['alb-1', 'alb-1']));
  });

  it('clears stale cancel flag when enqueueOfflinePin runs', async () => {
    cancelledDownloads.add('alb-1');
    const ran: string[] = [];
    registerOfflinePinExecutor(async (task, markStarted) => {
      markStarted();
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

  it('does not let a racing artist task replace an explicit queued album pin', async () => {
    const started: Array<{ albumId: string; type: string }> = [];
    const resolvers: Array<() => void> = [];
    registerOfflinePinExecutor(async (task, markStarted) => {
      markStarted();
      started.push({ albumId: task.albumId, type: task.type });
      await new Promise<void>(resolve => resolvers.push(resolve));
    });
    const base = {
      albumName: 'Album',
      albumArtist: 'A',
      coverArt: undefined,
      year: undefined,
      songs: [],
      serverId: 'srv',
    };
    enqueueOfflinePin({ ...base, albumId: 'active-1', type: 'album' });
    enqueueOfflinePin({ ...base, albumId: 'active-2', type: 'album' });
    enqueueOfflinePin({ ...base, albumId: 'queued', type: 'album' });
    await vi.waitFor(() => expect(isAlbumPinQueued('queued', 'srv')).toBe(true));

    expect(enqueueOfflinePin({
      ...base,
      albumId: 'queued',
      type: 'artist',
      artistProgressGroupId: 'artist',
    })).toBe(false);

    resolvers[0]?.();
    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(started[2]).toEqual({ albumId: 'queued', type: 'album' });
    resolvers.slice(1).forEach(resolve => resolve());
    await vi.waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
  });

  it('keeps same-id pins from different servers separate', async () => {
    const resolvers = new Map<string, () => void>();
    registerOfflinePinExecutor(async (task, markStarted) => {
      markStarted();
      await new Promise<void>(resolve => {
        resolvers.set(task.serverId, resolve);
      });
    });
    const base = {
      albumId: 'shared',
      albumName: 'Shared',
      albumArtist: 'A',
      coverArt: undefined,
      year: undefined,
      songs: [],
      type: 'playlist' as const,
    };

    expect(enqueueOfflinePin({ ...base, serverId: 'server-a' })).toBe(true);
    expect(enqueueOfflinePin({ ...base, serverId: 'server-b' })).toBe(true);
    await vi.waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toHaveLength(2));
    expect(useOfflineJobStore.getState().pinQueue.every(p => p.status === 'downloading')).toBe(true);
    useOfflineJobStore.getState().cancelDownload('shared', 'server-b');
    removeOfflinePinTask('shared', 'server-b');
    expect(useOfflineJobStore.getState().pinQueue).toEqual([
      expect.objectContaining({ albumId: 'shared', serverId: 'server-a', status: 'downloading' }),
    ]);

    resolvers.forEach(resolve => resolve());
    await vi.waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
  });

  it('does not replace the in-flight task when a download is active', async () => {
    let capturedTrackIds: string[] = [];
    const gate = { unblock: undefined as (() => void) | undefined };
    registerOfflinePinExecutor(async (task, markStarted) => {
      markStarted();
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
    await vi.waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
  });

  it('dispatches separate albums without global head-of-line blocking', async () => {
    const order: string[] = [];
    const resolvers: Array<() => void> = [];
    registerOfflinePinExecutor(async (task, markStarted) => {
      markStarted();
      order.push(task.albumId);
      await new Promise<void>(resolve => resolvers.push(resolve));
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

    await vi.waitFor(() => expect(order).toEqual(['alb-1', 'alb-2']));
    expect(useOfflineJobStore.getState().pinQueue.every(p => p.status === 'downloading')).toBe(true);

    resolvers.forEach(resolve => resolve());
    await vi.waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
  });

  it('counts artist bulk progress only for the current task generation', async () => {
    const resolvers: Array<() => void> = [];
    registerOfflinePinExecutor(async (_task, markStarted) => {
      markStarted();
      await new Promise<void>(resolve => resolvers.push(resolve));
    });
    const task = {
      albumId: 'alb-1',
      albumName: 'One',
      albumArtist: 'A',
      coverArt: undefined,
      year: undefined,
      songs: [],
      serverId: 'srv',
      type: 'artist' as const,
      artistProgressGroupId: 'artist-1',
    };
    useOfflineJobStore.setState({ bulkProgress: { 'artist-1': { done: 0, total: 1 } } });

    enqueueOfflinePin(task);
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    useOfflineJobStore.getState().cancelDownload('alb-1', 'srv');
    removeOfflinePinTask('alb-1', 'srv');
    enqueueOfflinePin(task);

    resolvers[0]?.();
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    expect(useOfflineJobStore.getState().bulkProgress['artist-1']?.done).toBe(0);

    resolvers[1]?.();
    await vi.waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
    expect(useOfflineJobStore.getState().bulkProgress['artist-1']?.done).toBe(1);
  });

  it('removes cancelled artist work from bulk progress without a retry', async () => {
    let unblock!: () => void;
    registerOfflinePinExecutor(async (_task, markStarted) => {
      markStarted();
      await new Promise<void>(resolve => {
        unblock = resolve;
      });
      return 'cancelled';
    });
    useOfflineJobStore.setState({ bulkProgress: { 'artist-1': { done: 0, total: 1 } } });
    enqueueOfflinePin({
      albumId: 'alb-1',
      albumName: 'One',
      albumArtist: 'A',
      coverArt: undefined,
      year: undefined,
      songs: [],
      serverId: 'srv',
      type: 'artist',
      artistProgressGroupId: 'artist-1',
    });
    await vi.waitFor(() => expect(unblock).toBeTypeOf('function'));

    useOfflineJobStore.getState().cancelDownload('alb-1', 'srv');
    removeOfflinePinTask('alb-1', 'srv');
    unblock();

    await vi.waitFor(() => expect(useOfflineJobStore.getState().bulkProgress).toEqual({}));
    expect(useOfflineJobStore.getState().pinQueue).toEqual([]);
  });

  it('detaches artist progress when an album retry replaces the artist generation', async () => {
    const resolvers: Array<() => void> = [];
    registerOfflinePinExecutor(async (_task, markStarted) => {
      markStarted();
      await new Promise<void>(resolve => resolvers.push(resolve));
    });
    const artistTask = {
      albumId: 'alb-1',
      albumName: 'One',
      albumArtist: 'A',
      coverArt: undefined,
      year: undefined,
      songs: [],
      serverId: 'srv',
      type: 'artist' as const,
      artistProgressGroupId: 'artist-1',
    };
    useOfflineJobStore.setState({ bulkProgress: { 'artist-1': { done: 0, total: 1 } } });
    enqueueOfflinePin(artistTask);
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));

    useOfflineJobStore.getState().cancelDownload('alb-1', 'srv');
    removeOfflinePinTask('alb-1', 'srv');
    enqueueOfflinePin({ ...artistTask, type: 'album', artistProgressGroupId: undefined });
    resolvers[0]?.();

    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    expect(useOfflineJobStore.getState().bulkProgress).toEqual({});
    resolvers[1]?.();
    await vi.waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
  });

  it('detaches artist progress when a direct pin replaces a still-queued artist task', async () => {
    const resolvers: Array<() => void> = [];
    registerOfflinePinExecutor(async (_task, markStarted) => {
      markStarted();
      await new Promise<void>(resolve => resolvers.push(resolve));
    });
    const base = {
      albumName: 'Album',
      albumArtist: 'A',
      coverArt: undefined,
      year: undefined,
      songs: [],
      serverId: 'srv',
    };
    enqueueOfflinePin({ ...base, albumId: 'active-1', type: 'album' });
    enqueueOfflinePin({ ...base, albumId: 'active-2', type: 'album' });
    useOfflineJobStore.setState({ bulkProgress: { artist: { done: 0, total: 1 } } });
    enqueueOfflinePin({
      ...base,
      albumId: 'queued',
      type: 'artist',
      artistProgressGroupId: 'artist',
    });
    await vi.waitFor(() => expect(isAlbumPinQueued('queued', 'srv')).toBe(true));

    expect(enqueueOfflinePin({ ...base, albumId: 'queued', type: 'album' })).toBe(true);
    expect(useOfflineJobStore.getState().bulkProgress.artist).toBeUndefined();

    resolvers.forEach(resolve => resolve());
    await vi.waitFor(() => expect(resolvers).toHaveLength(3));
    resolvers[2]?.();
    await vi.waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
  });

  it('cancels a dispatched artist generation before running its direct replacement', async () => {
    const started: Array<{ type: string; cancelledAtFinish: boolean }> = [];
    const resolvers: Array<() => void> = [];
    registerOfflinePinExecutor(async (task) => {
      await new Promise<void>(resolve => resolvers.push(resolve));
      const cancelledAtFinish = cancelledDownloads.has(`${task.serverId}:${task.albumId}`);
      started.push({ type: task.type, cancelledAtFinish });
      return cancelledAtFinish ? 'cancelled' : 'completed';
    });
    const base = {
      albumId: 'album',
      albumName: 'Album',
      albumArtist: 'A',
      coverArt: undefined,
      year: undefined,
      songs: [],
      serverId: 'srv',
    };
    useOfflineJobStore.setState({ bulkProgress: { artist: { done: 0, total: 1 } } });
    enqueueOfflinePin({
      ...base,
      type: 'artist',
      artistProgressGroupId: 'artist',
    });
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));

    expect(enqueueOfflinePin({ ...base, type: 'album' })).toBe(true);
    expect(cancelledDownloads.has('srv:album')).toBe(true);
    resolvers[0]?.();

    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    expect(started).toEqual([{ type: 'artist', cancelledAtFinish: true }]);
    resolvers[1]?.();
    await vi.waitFor(() => expect(started).toEqual([
      { type: 'artist', cancelledAtFinish: true },
      { type: 'album', cancelledAtFinish: false },
    ]));
    await vi.waitFor(() => expect(useOfflineJobStore.getState().pinQueue).toEqual([]));
  });
});
