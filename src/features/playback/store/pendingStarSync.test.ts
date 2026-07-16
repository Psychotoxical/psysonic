import { beforeEach, describe, expect, it, vi } from 'vitest';

const starMock = vi.fn(async (..._args: unknown[]) => undefined);
const unstarMock = vi.fn(async (..._args: unknown[]) => undefined);
const setRatingForServerMock = vi.fn(async (..._args: unknown[]) => undefined);
const resolveSourcesMock = vi.fn();
const showToastMock = vi.fn();

vi.mock('@/lib/api/subsonicStarRating', () => ({
  star: (...args: unknown[]) => starMock(...args),
  unstar: (...args: unknown[]) => unstarMock(...args),
  setRatingForServer: (...args: unknown[]) => setRatingForServerMock(...args),
}));
vi.mock('@/lib/api/library/scopeReads', () => ({
  libraryResolveEntitySources: (...args: unknown[]) => resolveSourcesMock(...args),
}));
vi.mock('@/lib/dom/toast', () => ({ showToast: (...args: unknown[]) => showToastMock(...args) }));

import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { usePlayerStore } from './playerStore';
import { getCachedTrack, seedQueueResolver, _resetQueueResolverForTest } from './queueTrackResolver';
import { entityOverrideKey } from '@/lib/media/entityOverrideKey';
import {
  _getPendingEntityMutationsForTest,
  _resetPendingEntityMutationMemoryForTest,
  _resetPendingStarSyncForTest,
  discardPendingEntityMutationsForServer,
  flushPendingEntityMutations,
  queueEntityRating,
  queueSongRating,
  queueSongStar,
} from './pendingStarSync';

const ready = (serverId: string) => ({
  serverId,
  libraryScope: '',
  syncPhase: 'ready',
  capabilityFlags: 0,
  libraryTier: '',
});

function setupServers(options?: { secondReady?: boolean; secondOnline?: boolean }): void {
  useAuthStore.setState({
    activeServerId: 's1',
    servers: [
      { id: 's1', name: 'One', url: 'https://one.test', username: 'u', password: 'p' },
      { id: 's2', name: 'Two', url: 'https://two.test', username: 'u', password: 'p' },
    ],
    musicLibraryServerIds: ['s1', 's2'],
    musicLibrarySelectionByServer: { s1: [], s2: [] },
    musicLibraryFilterByServer: {},
    entityRatingSupportByServer: { s1: 'full', s2: 'full' },
  });
  useLibraryIndexStore.setState({
    statusByServer: {
      'one.test': ready('one.test'),
      ...(options?.secondReady === false ? {} : { 'two.test': ready('two.test') }),
    },
    connectionByServer: {
      'one.test': 'online',
      'two.test': options?.secondOnline === false ? 'offline' : 'online',
    },
  });
}

describe('pending entity mutation outbox', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetPendingStarSyncForTest();
    _resetQueueResolverForTest();
    starMock.mockClear();
    unstarMock.mockClear();
    setRatingForServerMock.mockClear();
    resolveSourcesMock.mockReset();
    showToastMock.mockClear();
    usePlayerStore.setState({
      currentTrack: null,
      queueServerId: null,
      starredOverrides: {},
      userRatingOverrides: {},
    });
    setupServers();
    resolveSourcesMock.mockResolvedValue([
      { serverId: 's1', id: 'a1', libraryId: '', priority: 0 },
      { serverId: 's2', id: 'b1', libraryId: '', priority: 1 },
    ]);
  });

  it('fans out to every matching ready online target and patches only its qualified cache row', async () => {
    seedQueueResolver('s1', [{ id: 'a1', title: 'A', artist: '', album: '', albumId: '', duration: 1 }]);
    seedQueueResolver('s2', [{ id: 'a1', title: 'same raw id', artist: '', album: '', albumId: '', duration: 1 }]);
    queueSongStar('a1', true, 's1');
    await vi.waitFor(() => expect(starMock).toHaveBeenCalledTimes(2));

    expect(starMock).toHaveBeenCalledWith('a1', 'song', { serverId: 's1' });
    expect(starMock).toHaveBeenCalledWith('b1', 'song', { serverId: 's2' });
    expect(usePlayerStore.getState().starredOverrides).toMatchObject({
      [entityOverrideKey('s1', 'a1')]: true,
      [entityOverrideKey('s2', 'b1')]: true,
    });
    expect(getCachedTrack({ serverId: 's1', trackId: 'a1' })?.starred).toBeTruthy();
    expect(getCachedTrack({ serverId: 's2', trackId: 'a1' })?.starred).toBeUndefined();
    expect(_getPendingEntityMutationsForTest()).toEqual([]);
  });

  it.each(['primary', 'alias', null])('mutates a same-index selection once through its owner when active is %s', async activeServerId => {
    useAuthStore.setState({
      activeServerId,
      servers: [
        { id: 'primary', name: 'Primary', url: 'https://same.test', username: 'u', password: 'p' },
        { id: 'alias', name: 'Alias', url: 'http://same.test/', username: 'u', password: 'p' },
      ],
      musicLibraryServerIds: ['alias', 'primary'],
      musicLibrarySelectionByServer: { primary: ['one'], alias: ['two'] },
      musicLibraryFilterByServer: {},
      entityRatingSupportByServer: { primary: 'full', alias: 'full' },
    });
    useLibraryIndexStore.setState({
      statusByServer: { 'same.test': ready('same.test') },
      connectionByServer: { 'same.test': 'online' },
    });
    resolveSourcesMock.mockResolvedValue([
      { serverId: 'primary', id: 'resolved', libraryId: 'one', priority: 0 },
    ]);

    queueSongRating('anchor', 5, 'primary');
    await vi.waitFor(() => expect(setRatingForServerMock).toHaveBeenCalledWith('primary', 'resolved', 5));
    expect(setRatingForServerMock).toHaveBeenCalledTimes(1);
    expect(resolveSourcesMock).toHaveBeenCalledWith('primary', expect.objectContaining({
      scopes: [
        { serverId: 'primary', libraryId: 'one' },
        { serverId: 'primary', libraryId: 'two' },
      ],
    }));
    expect(_getPendingEntityMutationsForTest()).toEqual([]);
  });

  it('persists an offline concrete target and retries it after reconnect', async () => {
    setupServers({ secondOnline: false });
    queueSongRating('a1', 4, 's1');
    await vi.waitFor(() => expect(setRatingForServerMock).toHaveBeenCalledWith('s1', 'a1', 4));

    expect(_getPendingEntityMutationsForTest()).toEqual([
      expect.objectContaining({ targetServerId: 's2', entityId: 'b1', value: 4, resolution: 'resolved' }),
    ]);
    expect(localStorage.getItem('psysonic-entity-mutation-outbox-v1')).toContain('b1');

    useLibraryIndexStore.setState(state => ({
      connectionByServer: { ...state.connectionByServer, 'two.test': 'online' },
    }));
    await flushPendingEntityMutations('s2');
    expect(setRatingForServerMock).toHaveBeenCalledWith('s2', 'b1', 4);
    expect(_getPendingEntityMutationsForTest()).toEqual([]);
  });

  it('restores persisted concrete targets after an app restart', async () => {
    setupServers({ secondOnline: false });
    queueSongRating('a1', 4, 's1');
    await vi.waitFor(() => expect(localStorage.getItem('psysonic-entity-mutation-outbox-v1')).toContain('b1'));
    _resetPendingEntityMutationMemoryForTest();

    useLibraryIndexStore.setState(state => ({
      connectionByServer: { ...state.connectionByServer, 'two.test': 'online' },
    }));
    await flushPendingEntityMutations('s2');
    expect(setRatingForServerMock).toHaveBeenCalledWith('s2', 'b1', 4);
    expect(_getPendingEntityMutationsForTest()).toEqual([]);
  });

  it('keeps a deferred logical target until its index becomes ready', async () => {
    setupServers({ secondReady: false });
    resolveSourcesMock.mockResolvedValueOnce([
      { serverId: 's1', id: 'a1', libraryId: '', priority: 0 },
    ]);
    queueSongStar('a1', true, 's1');
    await vi.waitFor(() => expect(starMock).toHaveBeenCalledTimes(1));
    expect(_getPendingEntityMutationsForTest()).toEqual([
      expect.objectContaining({ targetServerId: 's2', resolution: 'awaiting_index', anchorId: 'a1' }),
    ]);

    resolveSourcesMock.mockResolvedValueOnce([
      { serverId: 's2', id: 'b1', libraryId: '', priority: 0 },
    ]);
    useLibraryIndexStore.setState(state => ({
      statusByServer: { ...state.statusByServer, 'two.test': ready('two.test') },
    }));
    await flushPendingEntityMutations('s2');
    expect(starMock).toHaveBeenCalledWith('b1', 'song', { serverId: 's2' });
    expect(_getPendingEntityMutationsForTest()).toEqual([]);
  });

  it('coalesces different deferred anchors resolving to one concrete target by newest updatedAt', async () => {
    setupServers({ secondReady: false });
    resolveSourcesMock.mockResolvedValue([]);
    queueSongRating('anchor-old', 2, 's1');
    queueSongRating('anchor-new', 5, 's1');
    await vi.waitFor(() => expect(_getPendingEntityMutationsForTest().filter(task => task.targetServerId === 's2')).toHaveLength(2));

    resolveSourcesMock.mockResolvedValue([
      { serverId: 's2', id: 'same-target', libraryId: '', priority: 0 },
    ]);
    useLibraryIndexStore.setState(state => ({
      statusByServer: { ...state.statusByServer, 'two.test': ready('two.test') },
    }));
    await flushPendingEntityMutations('s2');
    expect(setRatingForServerMock).toHaveBeenCalledWith('s2', 'same-target', 5);
    expect(setRatingForServerMock).not.toHaveBeenCalledWith('s2', 'same-target', 2);
  });

  it('retains a deferred logical target when a ready index transiently resolves empty', async () => {
    setupServers({ secondReady: false });
    resolveSourcesMock.mockResolvedValueOnce([
      { serverId: 's1', id: 'a1', libraryId: '', priority: 0 },
    ]);
    queueSongStar('a1', true, 's1');
    await vi.waitFor(() => expect(_getPendingEntityMutationsForTest()).toEqual([
      expect.objectContaining({ targetServerId: 's2', resolution: 'awaiting_index' }),
    ]));

    resolveSourcesMock.mockResolvedValueOnce([]);
    useLibraryIndexStore.setState(state => ({
      statusByServer: { ...state.statusByServer, 'two.test': ready('two.test') },
    }));
    await flushPendingEntityMutations('s2');

    expect(_getPendingEntityMutationsForTest()).toEqual([
      expect.objectContaining({ targetServerId: 's2', resolution: 'awaiting_index' }),
    ]);
  });

  it('retires a deferred logical target only on explicit permanent no-match', async () => {
    setupServers({ secondReady: false });
    resolveSourcesMock.mockResolvedValueOnce([
      { serverId: 's1', id: 'a1', libraryId: '', priority: 0 },
    ]);
    queueSongStar('a1', true, 's1');
    await vi.waitFor(() => expect(_getPendingEntityMutationsForTest()).toHaveLength(1));

    resolveSourcesMock.mockRejectedValueOnce({ code: 'no_matching_copy' });
    useLibraryIndexStore.setState(state => ({
      statusByServer: { ...state.statusByServer, 'two.test': ready('two.test') },
    }));
    await flushPendingEntityMutations('s2');

    expect(_getPendingEntityMutationsForTest()).toEqual([]);
  });

  it('flushes a newer desired value queued while the previous request is in flight', async () => {
    let finishFirst!: () => void;
    setRatingForServerMock.mockImplementationOnce(() => new Promise<undefined>(resolve => {
      finishFirst = () => resolve(undefined);
    }));

    queueSongRating('a1', 2, 's1');
    await vi.waitFor(() => expect(setRatingForServerMock).toHaveBeenCalledWith('s1', 'a1', 2));
    queueSongRating('a1', 5, 's1');
    await vi.waitFor(() => expect(_getPendingEntityMutationsForTest()).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetServerId: 's1', entityId: 'a1', value: 5 }),
    ])));

    finishFirst();
    await vi.waitFor(() => expect(setRatingForServerMock).toHaveBeenCalledWith('s1', 'a1', 5));
    await vi.waitFor(() => expect(_getPendingEntityMutationsForTest()).toEqual([]));
  });

  it('retires unsupported album ratings as permanent failures', async () => {
    useAuthStore.setState(state => ({
      entityRatingSupportByServer: { ...state.entityRatingSupportByServer, s2: 'track_only' },
    }));
    queueEntityRating('album', 'album-a', 5, 's1');
    await vi.waitFor(() => expect(setRatingForServerMock).toHaveBeenCalledWith('s1', 'a1', 5));
    expect(setRatingForServerMock).not.toHaveBeenCalledWith('s2', 'b1', 5);
    expect(_getPendingEntityMutationsForTest()).toEqual([]);
    expect(showToastMock).toHaveBeenCalled();
  });

  it('discards all pending rows for a deleted server with one notice', async () => {
    setupServers({ secondOnline: false });
    queueSongStar('a1', true, 's1');
    queueSongRating('a1', 3, 's1');
    await vi.waitFor(() => expect(_getPendingEntityMutationsForTest().some(task => task.targetServerId === 's2')).toBe(true));
    discardPendingEntityMutationsForServer('s2');
    expect(_getPendingEntityMutationsForTest().some(task => task.targetServerId === 's2')).toBe(false);
    expect(showToastMock).toHaveBeenCalledTimes(1);
  });
});
