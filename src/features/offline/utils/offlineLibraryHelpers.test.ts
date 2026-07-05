import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { useOfflineStore } from '@/features/offline/store/offlineStore';
import { switchActiveServer } from '@/utils/server/switchActiveServer';
import {
  buildOfflineCacheQueueTracks,
  countFavoriteAutoTracks,
  buildTracksForOfflineCard,
  ensureServerForOfflineCard,
  hasAnyOfflineAlbums,
  hydrateOfflineLibraryCards,
  isOfflinePinComplete,
  pendingOfflinePinSongs,
  offlineAlbumCoverScope,
  offlineTrackCount,
  type OfflineLibraryCard,
} from '@/features/offline/utils/offlineLibraryHelpers';
import * as libraryApi from '@/lib/api/library';
import { coverStorageKey } from '@/cover/storageKeys';
import { resolveCoverDisplayTier } from '@/cover/tiers';

vi.mock('@/utils/server/switchActiveServer', () => ({
  switchActiveServer: vi.fn(async () => true),
}));

vi.mock('@/lib/api/library', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api/library')>();
  const libraryGetTracksBatch = vi.fn();
  return {
    ...actual,
    libraryGetTracksBatch,
    libraryGetTracksBatchChunked: async (refs: Parameters<typeof actual.libraryGetTracksBatch>[0]) => {
      if (refs.length === 0) return [];
      const out: Awaited<ReturnType<typeof actual.libraryGetTracksBatch>> = [];
      for (let i = 0; i < refs.length; i += actual.LIBRARY_TRACKS_BATCH_LIMIT) {
        const chunk = refs.slice(i, i + actual.LIBRARY_TRACKS_BATCH_LIMIT);
        const batch = await libraryGetTracksBatch(chunk).catch(() => []);
        out.push(...batch);
      }
      return out;
    },
    libraryGetTrack: vi.fn(),
  };
});

describe('offlineLibraryHelpers', () => {
  beforeEach(() => {
    useAuthStore.setState({
      servers: [{ id: 'a', name: 'Home', url: 'http://a.test', username: 'u', password: 'p' }],
      activeServerId: 'a',
    });
    useLocalPlaybackStore.setState({ entries: {} });
  });

  it('countFavoriteAutoTracks counts favorite-auto tier rows only', () => {
    expect(countFavoriteAutoTracks()).toBe(0);
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/fav/t1.mp3',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'favorite-auto',
          cachedAt: 1,
          suffix: 'mp3',
        },
        'a.test:t2': {
          serverIndexKey: 'a.test',
          trackId: 't2',
          localPath: '/lib/t2.mp3',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
        },
      },
    });
    expect(countFavoriteAutoTracks()).toBe(1);
  });

  it('pendingOfflinePinSongs skips already pinned tracks', () => {
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/x',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
        },
      },
    });
    expect(pendingOfflinePinSongs([{ id: 't1' }, { id: 't2' }], 'a')).toEqual([{ id: 't2' }]);
  });

  it('isOfflinePinComplete with songIds finds entries stored under server UUID', () => {
    useLocalPlaybackStore.setState({
      entries: {
        'a:t1': {
          serverIndexKey: 'a',
          trackId: 't1',
          localPath: '/x',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
        },
      },
    });
    expect(isOfflinePinComplete('al1', 'a', ['t1'])).toBe(true);
  });

  it('isOfflinePinComplete checks localPlaybackStore pins by index key', () => {
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/x',
          layoutFingerprint: 'fp',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
          pinSource: { kind: 'album', sourceId: 'al1' },
        },
      },
    });
    useOfflineStore.setState({
      albums: {
        'a.test:al1': {
          id: 'al1',
          serverId: 'a.test',
          name: 'Al',
          artist: 'Ar',
          trackIds: ['t1'],
        },
      },
    });
    expect(isOfflinePinComplete('al1', 'a')).toBe(true);
  });

  it('hasAnyOfflineAlbums is true when pinned groups exist', () => {
    expect(hasAnyOfflineAlbums({})).toBe(false);
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/x',
          layoutFingerprint: '',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
          pinSource: { kind: 'album', sourceId: 'al1' },
        },
      },
    });
    expect(hasAnyOfflineAlbums({})).toBe(true);
  });

  it('offlineTrackCount counts pinned tracks on the card', () => {
    const card: OfflineLibraryCard = {
      serverIndexKey: 'a.test',
      pinSource: { kind: 'album', sourceId: 'al1' },
      trackIds: ['t1', 't2'],
      name: 'Al',
      artist: 'Ar',
    };
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/x',
          layoutFingerprint: '',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
        },
      },
    });
    expect(offlineTrackCount(card)).toBe(1);
  });

  it('offlineAlbumCoverScope is null when server profile is missing', () => {
    const card: OfflineLibraryCard = {
      serverIndexKey: 'gone',
      pinSource: { kind: 'album', sourceId: 'al1' },
      trackIds: [],
      name: 'Al',
      artist: 'Ar',
      coverArt: 'ca1',
    };
    expect(offlineAlbumCoverScope(card)).toBeNull();
  });

  it('offlineAlbumCoverScope uses host index key compatible with disk cache', () => {
    const card: OfflineLibraryCard = {
      serverIndexKey: 'a.test',
      pinSource: { kind: 'album', sourceId: 'al1' },
      trackIds: [],
      name: 'Al',
      artist: 'Ar',
      coverArt: 'ca1',
    };
    const scope = offlineAlbumCoverScope(card);
    expect(scope).toMatchObject({ kind: 'server', serverId: 'a' });
    const tier = resolveCoverDisplayTier(300, { surface: 'dense' });
    expect(coverStorageKey(scope!, { cacheKind: 'album', cacheEntityId: 'ca1' }, tier)).toBe(
      'a.test:cover:album:ca1:512',
    );
  });

  it('ensureServerForOfflineCard skips switch when already active', async () => {
    vi.mocked(switchActiveServer).mockClear();
    const card: OfflineLibraryCard = {
      serverIndexKey: 'a.test',
      pinSource: { kind: 'album', sourceId: 'al1' },
      trackIds: [],
      name: 'Al',
      artist: 'Ar',
    };
    await expect(ensureServerForOfflineCard(card)).resolves.toBe(true);
    expect(switchActiveServer).not.toHaveBeenCalled();
  });

  it('hydrateOfflineLibraryCards falls back to albumId when coverArtId is missing', async () => {
    vi.mocked(libraryApi.libraryGetTracksBatch).mockResolvedValueOnce([{
      serverId: 'a',
      id: 't1',
      title: 'Song',
      album: 'Al',
      albumId: 'al-1',
      durationSec: 100,
      syncedAt: 1,
      rawJson: {},
    }]);
    const cards = await hydrateOfflineLibraryCards([{
      serverIndexKey: 'a.test',
      pinSource: { kind: 'album', sourceId: 'al-1', displayName: 'Al' },
      trackIds: ['t1'],
    }]);
    expect(cards[0]?.coverArt).toBe('al-1');
  });

  it('hydrateOfflineLibraryCards uses playlist name, quad cover, and no artist line', async () => {
    vi.mocked(libraryApi.libraryGetTracksBatch).mockResolvedValueOnce([
      {
        serverId: 'a',
        id: 't1',
        title: 'Song A',
        artist: 'Artist A',
        album: 'Album A',
        albumId: 'al-a',
        coverArtId: 'cov-a',
        durationSec: 100,
        syncedAt: 1,
        rawJson: {},
      },
      {
        serverId: 'a',
        id: 't2',
        title: 'Song B',
        artist: 'Artist B',
        album: 'Album B',
        albumId: 'al-b',
        coverArtId: 'cov-b',
        durationSec: 100,
        syncedAt: 1,
        rawJson: {},
      },
    ]);
    const cards = await hydrateOfflineLibraryCards([{
      serverIndexKey: 'a.test',
      pinSource: { kind: 'playlist', sourceId: 'pl-1', displayName: 'My Mix' },
      trackIds: ['t1', 't2'],
    }]);
    expect(cards[0]?.name).toBe('My Mix');
    expect(cards[0]?.artist).toBe('');
    expect(cards[0]?.coverArt).toBeUndefined();
    expect(cards[0]?.coverQuadIds).toEqual(['cov-a', 'cov-b', 'cov-a', 'cov-b']);
  });

  it('hydrateOfflineLibraryCards uses legacy offline album coverArt', async () => {
    vi.mocked(libraryApi.libraryGetTracksBatch).mockResolvedValueOnce([]);
    useOfflineStore.setState({
      albums: {
        'a.test:al-1': {
          id: 'al-1',
          serverId: 'a.test',
          name: 'Al',
          artist: 'Ar',
          coverArt: 'legacy-cover',
          trackIds: ['t1'],
        },
      },
    });
    const cards = await hydrateOfflineLibraryCards([{
      serverIndexKey: 'a.test',
      pinSource: { kind: 'album', sourceId: 'al-1' },
      trackIds: ['t1'],
    }]);
    expect(cards[0]?.coverArt).toBe('legacy-cover');
  });

  it('buildTracksForOfflineCard falls back to local index when library batch misses', async () => {
    vi.mocked(libraryApi.libraryGetTracksBatch).mockResolvedValueOnce([]);
    vi.mocked(libraryApi.libraryGetTrack).mockResolvedValue(null as never);
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/media/library/a.test/Artist/Album/track.mp3',
          layoutFingerprint: 'fp',
          sizeBytes: 1000,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
          pinSource: { kind: 'album', sourceId: 'al1' },
        },
      },
    });
    const tracks = await buildTracksForOfflineCard({
      serverIndexKey: 'a.test',
      pinSource: { kind: 'album', sourceId: 'al1', displayName: 'Album' },
      trackIds: ['t1'],
      name: 'Album',
      artist: 'Artist',
    });
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.id).toBe('t1');
    expect(tracks[0]?.suffix).toBe('mp3');
  });

  it('buildOfflineCacheQueueTracks includes only ephemeral cache tracks', async () => {
    const hotDto = {
      id: 'hot1',
      serverId: 'a',
      title: 'Hot',
      artist: 'Ar',
      album: 'Al',
      albumId: 'al2',
      duration: 120,
      suffix: 'flac',
    };
    vi.mocked(libraryApi.libraryGetTracksBatch).mockResolvedValueOnce([hotDto] as never);
    useLocalPlaybackStore.setState({
      entries: {
        'a.test:t1': {
          serverIndexKey: 'a.test',
          trackId: 't1',
          localPath: '/media/library/a.test/Artist/Album/one.mp3',
          layoutFingerprint: 'fp',
          sizeBytes: 1000,
          tier: 'library',
          cachedAt: 1,
          suffix: 'mp3',
          pinSource: { kind: 'album', sourceId: 'al1' },
        },
        'a.test:hot1': {
          serverIndexKey: 'a.test',
          trackId: 'hot1',
          localPath: '/media/cache/a.test/hot1.flac',
          layoutFingerprint: 'fp2',
          sizeBytes: 2000,
          tier: 'ephemeral',
          cachedAt: 2,
          suffix: 'flac',
        },
      },
    });
    const { tracks, queueServerIndexKey } = await buildOfflineCacheQueueTracks();
    expect(queueServerIndexKey).toBe('a.test');
    expect(tracks.map(t => t.id)).toEqual(['hot1']);
  });

  it('ensureServerForOfflineCard switches when card is on another server', async () => {
    useAuthStore.setState({
      servers: [
        { id: 'a', name: 'Home', url: 'http://a.test', username: 'u', password: 'p' },
        { id: 'b', name: 'Work', url: 'http://b.test', username: 'u', password: 'p' },
      ],
      activeServerId: 'b',
    });
    const card: OfflineLibraryCard = {
      serverIndexKey: 'a.test',
      pinSource: { kind: 'album', sourceId: 'al1' },
      trackIds: [],
      name: 'Al',
      artist: 'Ar',
    };
    await expect(ensureServerForOfflineCard(card)).resolves.toBe(true);
    expect(useAuthStore.getState().activeServerId).toBe('a');
    expect(switchActiveServer).not.toHaveBeenCalled();
  });
});
