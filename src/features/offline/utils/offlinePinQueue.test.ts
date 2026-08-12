import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelledDownloads, useOfflineJobStore } from '@/features/offline/store/offlineJobStore';
import {
  clearOfflinePinTasks,
  dequeueOfflinePin,
  enqueueOfflinePin,
  isAlbumPinQueued,
  registerOfflinePinExecutor,
  removeOfflinePinTask,
  cancelAndDrainOfflinePinQueue,
  resumeOfflinePinQueue,
} from '@/features/offline/utils/offlinePinQueue';
import {
  activateCanonicalNavidromeOwners,
  canonicalizeNavidromeId,
  deactivateCanonicalNavidromeOwners,
} from '@/lib/server/navidromeCanonicalIds';

describe('offlinePinQueue', () => {
  beforeEach(() => {
    deactivateCanonicalNavidromeOwners(['srv']);
    cancelledDownloads.clear();
    clearOfflinePinTasks(true);
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

  it('buffers a pin requested while the queue is paused', async () => {
    const ran: string[] = [];
    registerOfflinePinExecutor(async task => { ran.push(task.albumId); });
    await cancelAndDrainOfflinePinQueue();

    expect(enqueueOfflinePin({
      albumId: 'alb-paused', albumName: 'Paused', albumArtist: 'A', coverArt: undefined,
      year: undefined, songs: [], serverId: 'srv', type: 'album',
    })).toBe(true);
    expect(ran).toEqual([]);

    resumeOfflinePinQueue();
    await vi.waitFor(() => expect(ran).toEqual(['alb-paused']));
  });

  it('allows a buffered pin to be removed before resume', async () => {
    const ran: string[] = [];
    registerOfflinePinExecutor(async task => { ran.push(task.albumId); });
    await cancelAndDrainOfflinePinQueue();
    enqueueOfflinePin({
      albumId: 'alb-cancelled', albumName: 'Cancelled', albumArtist: 'A', coverArt: undefined,
      year: undefined, songs: [], serverId: 'srv', type: 'album',
    });

    removeOfflinePinTask('alb-cancelled', 'srv');
    resumeOfflinePinQueue();
    await Promise.resolve();

    expect(ran).toEqual([]);
  });

  it('keeps same-id pins from different servers separate', async () => {
    const gate = { unblock: undefined as (() => void) | undefined };
    registerOfflinePinExecutor(async () => {
      await new Promise<void>(resolve => {
        gate.unblock = resolve;
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
    expect(isAlbumPinQueued('shared', 'server-b')).toBe(true);
    expect(dequeueOfflinePin('shared', 'server-b')).toBe(true);
    expect(useOfflineJobStore.getState().pinQueue).toEqual([
      expect.objectContaining({ albumId: 'shared', serverId: 'server-a', status: 'downloading' }),
    ]);

    gate.unblock?.();
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

  it('canonicalizes a queued legacy payload again when execution begins after ACK', async () => {
    const legacyAlbumId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const legacyTrackId = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
    const legacyCoverId = '00112233-4455-6677-8899-aabbccddeeff';
    const firstGate = { unblock: undefined as (() => void) | undefined };
    const executed: Array<{ albumId: string; coverArt?: string; trackId?: string }> = [];
    registerOfflinePinExecutor(async task => {
      executed.push({
        albumId: task.albumId,
        coverArt: task.coverArt,
        trackId: task.songs[0]?.id,
      });
      if (executed.length === 1) {
        await new Promise<void>(resolve => { firstGate.unblock = resolve; });
      }
    });

    enqueueOfflinePin({
      albumId: 'first', albumName: 'First', albumArtist: 'A', coverArt: undefined,
      year: undefined, songs: [], serverId: 'srv', type: 'album',
    });
    enqueueOfflinePin({
      albumId: legacyAlbumId,
      albumName: 'Legacy',
      albumArtist: 'A',
      coverArt: legacyCoverId,
      year: undefined,
      songs: [{
        id: legacyTrackId,
        title: 'Track',
        artist: 'A',
        album: 'Legacy',
        albumId: legacyAlbumId,
        coverArt: legacyCoverId,
        duration: 1,
      }],
      serverId: 'srv',
      type: 'album',
    });
    await vi.waitFor(() => expect(executed).toHaveLength(1));

    activateCanonicalNavidromeOwners(['srv']);
    firstGate.unblock?.();

    await vi.waitFor(() => expect(executed).toHaveLength(2));
    expect(executed[1]).toEqual({
      albumId: canonicalizeNavidromeId(legacyAlbumId),
      coverArt: canonicalizeNavidromeId(legacyCoverId),
      trackId: canonicalizeNavidromeId(legacyTrackId),
    });
    deactivateCanonicalNavidromeOwners(['srv']);
  });

  it('merges legacy and canonical queued representations without dropping the latest task', async () => {
    const legacyAlbumId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const legacyTrackId = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
    const canonicalAlbumId = canonicalizeNavidromeId(legacyAlbumId);
    const canonicalTrackId = canonicalizeNavidromeId(legacyTrackId);
    const firstGate = { unblock: undefined as (() => void) | undefined };
    const executed: Array<{ albumId: string; trackIds: string[] }> = [];
    registerOfflinePinExecutor(async task => {
      executed.push({ albumId: task.albumId, trackIds: task.songs.map(song => song.id) });
      if (executed.length === 1) {
        await new Promise<void>(resolve => { firstGate.unblock = resolve; });
      }
    });
    enqueueOfflinePin({
      albumId: 'first', albumName: 'First', albumArtist: 'A', coverArt: undefined,
      year: undefined, songs: [], serverId: 'srv', type: 'album',
    });
    enqueueOfflinePin({
      albumId: legacyAlbumId, albumName: 'Legacy', albumArtist: 'A', coverArt: undefined,
      year: undefined,
      songs: [{
        id: legacyTrackId, title: 'Old', artist: 'A', album: 'Legacy',
        albumId: legacyAlbumId, duration: 1,
      }],
      serverId: 'srv', type: 'album',
    });
    await vi.waitFor(() => expect(executed).toHaveLength(1));

    activateCanonicalNavidromeOwners(['srv']);
    expect(enqueueOfflinePin({
      albumId: canonicalAlbumId, albumName: 'Canonical', albumArtist: 'A', coverArt: undefined,
      year: undefined,
      songs: [{
        id: canonicalTrackId, title: 'New', artist: 'A', album: 'Canonical',
        albumId: canonicalAlbumId, duration: 1,
      }],
      serverId: 'srv', type: 'album',
    })).toBe(true);

    expect(useOfflineJobStore.getState().pinQueue.filter(entry => entry.status === 'queued')).toEqual([
      expect.objectContaining({ albumId: canonicalAlbumId, albumName: 'Canonical' }),
    ]);
    firstGate.unblock?.();
    await vi.waitFor(() => expect(executed).toHaveLength(2));
    expect(executed[1]).toEqual({ albumId: canonicalAlbumId, trackIds: [canonicalTrackId] });
  });
});
