import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../../store/authStore';
import { useLocalPlaybackStore } from '../../store/localPlaybackStore';
import { useOfflineStore } from '../../store/offlineStore';
import { switchActiveServer } from '../server/switchActiveServer';
import {
  ensureServerForOfflineCard,
  hasAnyOfflineAlbums,
  hydrateOfflineLibraryCards,
  isOfflinePinComplete,
  pendingOfflinePinSongs,
  offlineAlbumCoverScope,
  offlineTrackCount,
  type OfflineLibraryCard,
} from './offlineLibraryHelpers';
import * as libraryApi from '../../api/library';
import { coverStorageKey } from '../../cover/storageKeys';
import { resolveCoverDisplayTier } from '../../cover/tiers';

vi.mock('../server/switchActiveServer', () => ({
  switchActiveServer: vi.fn(async () => true),
}));

vi.mock('../../api/library', async importOriginal => {
  const actual = await importOriginal<typeof import('../../api/library')>();
  return {
    ...actual,
    libraryGetTracksBatch: vi.fn(),
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
    expect(switchActiveServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a' }),
    );
  });
});
