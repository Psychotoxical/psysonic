import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/library', () => ({
  libraryIdentityTransitionStatus: vi.fn(),
  libraryIdentityTransitionProbe: vi.fn(),
  libraryIdentityTransitionRunNativeMigration: vi.fn(),
  libraryIdentityTransitionAck: vi.fn(),
}));

vi.mock('@/lib/api/analysis', () => ({
  analysisClearServerCache: vi.fn(),
}));

vi.mock('@/features/lyrics/utils/lyricsPersistentCache', () => ({
  clearLyricsCache: vi.fn(),
}));

import {
  libraryIdentityTransitionAck,
  libraryIdentityTransitionProbe,
  libraryIdentityTransitionRunNativeMigration,
  libraryIdentityTransitionStatus,
} from '@/lib/api/library';
import { analysisClearServerCache } from '@/lib/api/analysis';
import { clearLyricsCache } from '@/features/lyrics/utils/lyricsPersistentCache';
import { useAuthStore } from '@/store/authStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { useOfflineStore } from '@/features/offline';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useDeviceSyncStore } from '@/features/deviceSync';
import { usePlaylistFolderStore, usePlaylistStore } from '@/features/playlist';
import { useMigrationStore } from '@/store/migrationStore';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';
import { persistShuffleModeSnapshot } from '@/features/playback/store/shuffleModeStorage';
import {
  canonicalizeNavidromeId,
  reconcileCanonicalEntityIds,
} from './reconcileCanonicalEntityIds';
import {
  canonicalizeConfirmedNavidromeId,
  deactivateCanonicalNavidromeOwners,
} from '@/lib/server/navidromeCanonicalIds';
import { resetBlockingMigrationCoordinatorForTests } from '@/store/migrationCoordinator';
import {
  _resetTimelineSessionHistoryForTest,
  appendTimelineSessionPlay,
  getTimelineSessionHistorySnapshot,
} from '@/features/playback/store/timelineSessionHistory';

const OLD_TRACK = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
const NEW_TRACK = '6VHl3uR4kss6sUPKA8Cwnk';
const OLD_ALBUM = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const NEW_ALBUM = '7rke2SAWaicSeSYzkhww6R';
const PROFILE_ID = 'profile-1';
const INDEX_KEY = 'music.test';

describe('canonical Navidrome IDs', () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(async () => {
    resetBlockingMigrationCoordinatorForTests();
    deactivateCanonicalNavidromeOwners([PROFILE_ID, INDEX_KEY, 'ready-profile', 'ready.music.test']);
    localStorage.clear();
    _resetTimelineSessionHistoryForTest();
    vi.mocked(libraryIdentityTransitionStatus).mockReset();
    vi.mocked(libraryIdentityTransitionAck).mockReset();
    vi.mocked(libraryIdentityTransitionProbe).mockReset();
    vi.mocked(libraryIdentityTransitionRunNativeMigration).mockReset();
    vi.mocked(analysisClearServerCache).mockReset();
    vi.mocked(clearLyricsCache).mockReset();
    await Promise.all([
      useAuthStore.persist.rehydrate(),
      usePlayerStore.persist.rehydrate(),
      useLocalPlaybackStore.persist.rehydrate(),
      useOfflineStore.persist.rehydrate(),
      useDeviceSyncStore.persist.rehydrate(),
      usePlaylistStore.persist.rehydrate(),
      usePlaylistFolderStore.persist.rehydrate(),
    ]);
    usePlayerStore.setState({ currentTrack: null, queueServerId: null, queueItems: [] });
    useLocalPlaybackStore.setState({ entries: {} });
    useOfflineStore.setState({ albums: {} });
    useDeviceSyncStore.setState({ sources: [], legacySources: [] });
    usePlaylistStore.setState({ playlists: [], recentIds: [], lastModified: {} });
    usePlaylistFolderStore.setState({ byServer: {} });
    usePlaylistMembershipStore.setState({ songIdsByCacheKey: {}, revision: 0 });
    useAuthStore.setState({
      skipStarManualSkipCountsByKey: {},
      musicFolders: [],
      musicFoldersByServer: {},
      libraryBrowseSelectionByServer: {},
      musicLibraryFilterByServer: {},
      musicLibrarySelectionByServer: {},
      musicLibraryFilterVersion: 0,
      libraryBrowseScopeVersion: 0,
    });
    useMigrationStore.setState({
      phase: 'completed',
      step: null,
      needsMigration: false,
      lastError: null,
    });
  });

  it('matches Navidrome upstream migration vectors', () => {
    expect(canonicalizeNavidromeId('5cLJPkLA5DK2BADhoeotPk')).toBe('5cLJPkLA5DK2BADhoeotPk');
    expect(canonicalizeNavidromeId('zzzzzzzzzzzzzzzzzzzzzz')).toBe('3LyqmwQBm5IRqlVjNYASwb');
    expect(canonicalizeNavidromeId(OLD_TRACK)).toBe(NEW_TRACK);
    expect(canonicalizeNavidromeId(OLD_ALBUM)).toBe(NEW_ALBUM);
    expect(canonicalizeNavidromeId('!!!!!!!!!!!!!!!!!!!!!!')).toBe('!!!!!!!!!!!!!!!!!!!!!!');
  });

  it('rewrites persisted state before acknowledging the native transition', async () => {
    vi.mocked(libraryIdentityTransitionStatus).mockResolvedValue({
      serverId: INDEX_KEY,
      state: 'transition_detected',
      canonicalVersion: 1,
      probeOldId: OLD_TRACK,
      probeNewId: NEW_TRACK,
      lastError: null,
    });
    vi.mocked(libraryIdentityTransitionRunNativeMigration).mockResolvedValue({
      serverId: INDEX_KEY,
      state: 'pending_frontend',
      canonicalVersion: 1,
      probeOldId: OLD_TRACK,
      probeNewId: NEW_TRACK,
      lastError: null,
    });
    vi.mocked(libraryIdentityTransitionAck).mockResolvedValue();
    vi.mocked(analysisClearServerCache).mockResolvedValue();
    vi.mocked(clearLyricsCache).mockResolvedValue();
    usePlayerStore.setState({
      queueServerId: INDEX_KEY,
      currentTrack: {
        id: OLD_TRACK,
        title: 'Track',
        artist: 'Artist',
        album: 'Album',
        albumId: OLD_ALBUM,
        duration: 120,
        serverId: PROFILE_ID,
      },
      queueItems: [
        { serverId: INDEX_KEY, trackId: OLD_TRACK },
        { serverId: 'other.test', trackId: OLD_TRACK },
      ],
      starredOverrides: {
        [`${PROFILE_ID}:${OLD_TRACK}`]: true,
        [`${PROFILE_ID}:${NEW_TRACK}`]: false,
        [`other-profile:${OLD_TRACK}`]: true,
      },
    });
    useLocalPlaybackStore.setState({
      entries: {
        [`${INDEX_KEY}:${OLD_TRACK}`]: {
          serverIndexKey: INDEX_KEY,
          trackId: OLD_TRACK,
          localPath: '/music/track.flac',
          layoutFingerprint: 'layout',
          sizeBytes: 10,
          tier: 'library',
          cachedAt: 1,
          pinSource: { kind: 'album', sourceId: OLD_ALBUM },
          suffix: 'flac',
        },
      },
    });
    useOfflineStore.setState({
      albums: {
        [`${INDEX_KEY}:${OLD_ALBUM}`]: {
          id: OLD_ALBUM,
          serverId: INDEX_KEY,
          name: 'Album',
          artist: 'Artist',
          trackIds: [OLD_TRACK],
        },
      },
    });
    useAuthStore.setState({
      skipStarManualSkipCountsByKey: {
        [`${PROFILE_ID}\u001f${OLD_TRACK}`]: 2,
        [`${PROFILE_ID}\u001f${NEW_TRACK}`]: 4,
        [`other-profile\u001f${OLD_TRACK}`]: 3,
      },
      activeServerId: PROFILE_ID,
      musicFolders: [{ id: OLD_ALBUM, name: 'Library' }],
      musicFoldersByServer: { [PROFILE_ID]: [{ id: OLD_ALBUM, name: 'Library' }] },
      libraryBrowseSelectionByServer: { [PROFILE_ID]: [OLD_ALBUM] },
      musicLibraryFilterByServer: { [PROFILE_ID]: OLD_ALBUM },
      musicLibrarySelectionByServer: { [PROFILE_ID]: [OLD_ALBUM] },
    });
    useDeviceSyncStore.setState({
      sources: [{ type: 'album', id: OLD_ALBUM, name: 'Album', serverIndexKey: INDEX_KEY }],
    });
    usePlaylistStore.setState({
      playlists: [{
        id: OLD_ALBUM,
        serverId: PROFILE_ID,
        name: 'Playlist',
        songCount: 1,
        duration: 120,
        created: '2026-01-01',
        changed: '2026-01-01',
      }],
      recentIds: [`${PROFILE_ID}:${OLD_ALBUM}`],
      lastModified: { [`${PROFILE_ID}:${OLD_ALBUM}`]: 10 },
    });
    usePlaylistFolderStore.setState({
      byServer: {
        [PROFILE_ID]: { folders: [], assignments: { [OLD_ALBUM]: 'folder-1' } },
      },
    });
    usePlaylistMembershipStore.getState().setPlaylistSongIds(OLD_ALBUM, [OLD_TRACK], PROFILE_ID);
    appendTimelineSessionPlay({ serverId: PROFILE_ID, trackId: OLD_TRACK, playedAtMs: 1 });
    appendTimelineSessionPlay({ serverId: 'other-profile', trackId: OLD_TRACK, playedAtMs: 2 });

    await reconcileCanonicalEntityIds({
      id: PROFILE_ID,
      name: 'Navidrome',
      url: 'https://music.test',
      username: 'user',
      password: 'password',
    }, INDEX_KEY);

    expect(usePlayerStore.getState().currentTrack?.id).toBe(NEW_TRACK);
    expect(usePlayerStore.getState().queueItems).toEqual([
      { serverId: INDEX_KEY, trackId: NEW_TRACK },
      { serverId: 'other.test', trackId: OLD_TRACK },
    ]);
    expect(usePlayerStore.getState().starredOverrides).toEqual({
      [`${PROFILE_ID}:${NEW_TRACK}`]: false,
      [`other-profile:${OLD_TRACK}`]: true,
    });
    const local = useLocalPlaybackStore.getState().entries[`${INDEX_KEY}:${NEW_TRACK}`];
    expect(local).toMatchObject({
      trackId: NEW_TRACK,
      localPath: '/music/track.flac',
      pinSource: { sourceId: NEW_ALBUM },
    });
    expect(useOfflineStore.getState().albums[`${INDEX_KEY}:${NEW_ALBUM}`]?.trackIds).toEqual([NEW_TRACK]);
    expect(useAuthStore.getState().skipStarManualSkipCountsByKey).toEqual({
      [`${PROFILE_ID}\u001f${NEW_TRACK}`]: 4,
      [`other-profile\u001f${OLD_TRACK}`]: 3,
    });
    expect(useAuthStore.getState().musicFolders[0]?.id).toBe(NEW_ALBUM);
    expect(useAuthStore.getState().musicFoldersByServer[PROFILE_ID]?.[0]?.id).toBe(NEW_ALBUM);
    expect(useAuthStore.getState().libraryBrowseSelectionByServer[PROFILE_ID]).toEqual([NEW_ALBUM]);
    expect(useAuthStore.getState().musicLibraryFilterByServer[PROFILE_ID]).toBe(NEW_ALBUM);
    expect(useAuthStore.getState().musicLibrarySelectionByServer[PROFILE_ID]).toEqual([NEW_ALBUM]);
    expect(useAuthStore.getState().musicLibraryFilterVersion).toBe(1);
    expect(useAuthStore.getState().libraryBrowseScopeVersion).toBe(1);
    expect(useDeviceSyncStore.getState().sources[0]?.id).toBe(NEW_ALBUM);
    expect(usePlaylistStore.getState()).toMatchObject({
      playlists: [],
      recentIds: [],
      lastModified: {},
    });
    expect(usePlaylistFolderStore.getState().byServer[PROFILE_ID]?.assignments).toEqual({
      [NEW_ALBUM]: 'folder-1',
    });
    expect(usePlaylistMembershipStore.getState().songIdsByCacheKey).toEqual({});
    expect(getTimelineSessionHistorySnapshot()).toEqual([
      { serverId: INDEX_KEY, trackId: NEW_TRACK, playedAtMs: 1 },
      { serverId: 'other-profile', trackId: OLD_TRACK, playedAtMs: 2 },
    ]);
    expect(analysisClearServerCache).toHaveBeenCalledWith(INDEX_KEY);
    expect(clearLyricsCache).toHaveBeenCalledTimes(1);
    expect(libraryIdentityTransitionRunNativeMigration).toHaveBeenCalledWith(INDEX_KEY);
    expect(libraryIdentityTransitionAck).toHaveBeenCalledWith(INDEX_KEY);
    expect(useMigrationStore.getState()).toMatchObject({
      phase: 'completed',
      step: null,
      needsMigration: false,
    });
  });

  it('does not acknowledge when a durable cache migration fails', async () => {
    vi.mocked(libraryIdentityTransitionStatus).mockResolvedValue({
      serverId: INDEX_KEY,
      state: 'pending_frontend',
      canonicalVersion: 1,
      probeOldId: OLD_TRACK,
      probeNewId: NEW_TRACK,
      lastError: null,
    });
    vi.mocked(analysisClearServerCache).mockRejectedValue(new Error('analysis locked'));

    await expect(reconcileCanonicalEntityIds({
      id: PROFILE_ID,
      name: 'Navidrome',
      url: 'https://music.test',
      username: 'user',
      password: 'password',
    }, INDEX_KEY)).rejects.toThrow('analysis locked');
    expect(libraryIdentityTransitionAck).not.toHaveBeenCalled();
  });

  it('does not acknowledge when current-track persistence fails', async () => {
    vi.mocked(libraryIdentityTransitionStatus).mockResolvedValue({
      serverId: INDEX_KEY,
      state: 'pending_frontend',
      canonicalVersion: 1,
      probeOldId: OLD_TRACK,
      probeNewId: NEW_TRACK,
      lastError: null,
    });
    vi.mocked(analysisClearServerCache).mockResolvedValue();
    vi.mocked(clearLyricsCache).mockResolvedValue();
    usePlayerStore.setState({
      queueServerId: INDEX_KEY,
      currentTrack: {
        id: OLD_TRACK,
        title: 'Track',
        artist: 'Artist',
        album: 'Album',
        albumId: OLD_ALBUM,
        duration: 120,
        serverId: PROFILE_ID,
      },
      queueItems: [{ serverId: INDEX_KEY, trackId: OLD_TRACK }],
    });
    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'psysonic-player') throw new DOMException('quota', 'QuotaExceededError');
      return originalSetItem(key, value);
    });

    await expect(reconcileCanonicalEntityIds({
      id: PROFILE_ID,
      name: 'Navidrome',
      url: 'https://music.test',
      username: 'user',
      password: 'password',
    }, INDEX_KEY)).rejects.toThrow('psysonic-player.currentTrack');

    setItem.mockRestore();
    expect(libraryIdentityTransitionAck).not.toHaveBeenCalled();
    expect(useMigrationStore.getState().phase).toBe('error');
  });

  it('does not acknowledge when shuffle persistence fails', async () => {
    vi.mocked(libraryIdentityTransitionStatus).mockResolvedValue({
      serverId: INDEX_KEY,
      state: 'pending_frontend',
      canonicalVersion: 1,
      probeOldId: OLD_TRACK,
      probeNewId: NEW_TRACK,
      lastError: null,
    });
    vi.mocked(analysisClearServerCache).mockResolvedValue();
    vi.mocked(clearLyricsCache).mockResolvedValue();
    persistShuffleModeSnapshot({
      enabled: true,
      originalOrder: [JSON.stringify([INDEX_KEY, OLD_TRACK])],
    });
    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'psysonic_shuffle_mode') throw new DOMException('quota', 'QuotaExceededError');
      return originalSetItem(key, value);
    });

    await expect(reconcileCanonicalEntityIds({
      id: PROFILE_ID,
      name: 'Navidrome',
      url: 'https://music.test',
      username: 'user',
      password: 'password',
    }, INDEX_KEY)).rejects.toThrow('shuffle state');

    setItem.mockRestore();
    expect(libraryIdentityTransitionAck).not.toHaveBeenCalled();
  });

  it('probes frontend-only legacy IDs when the native library has no candidate', async () => {
    vi.mocked(libraryIdentityTransitionStatus).mockResolvedValue({
      serverId: INDEX_KEY,
      state: 'awaiting_supplemental_probe',
      canonicalVersion: 1,
      probeOldId: null,
      probeNewId: null,
      lastError: null,
    });
    vi.mocked(libraryIdentityTransitionProbe).mockResolvedValue({
      serverId: INDEX_KEY,
      state: 'transition_detected',
      canonicalVersion: 1,
      probeOldId: OLD_TRACK,
      probeNewId: NEW_TRACK,
      lastError: null,
    });
    vi.mocked(libraryIdentityTransitionRunNativeMigration).mockResolvedValue({
      serverId: INDEX_KEY,
      state: 'pending_frontend',
      canonicalVersion: 1,
      probeOldId: OLD_TRACK,
      probeNewId: NEW_TRACK,
      lastError: null,
    });
    vi.mocked(analysisClearServerCache).mockResolvedValue();
    vi.mocked(clearLyricsCache).mockResolvedValue();
    vi.mocked(libraryIdentityTransitionAck).mockResolvedValue();
    usePlayerStore.setState({
      queueServerId: INDEX_KEY,
      currentTrack: null,
      queueItems: [{ serverId: INDEX_KEY, trackId: OLD_TRACK }],
    });

    await reconcileCanonicalEntityIds({
      id: PROFILE_ID,
      name: 'Navidrome',
      url: 'https://music.test',
      username: 'user',
      password: 'password',
    }, INDEX_KEY);

    expect(libraryIdentityTransitionProbe).toHaveBeenCalledWith(INDEX_KEY, [
      { entityKind: 'track', id: OLD_TRACK },
    ]);
    expect(usePlayerStore.getState().queueItems[0]?.trackId).toBe(NEW_TRACK);
    expect(libraryIdentityTransitionAck).toHaveBeenCalledWith(INDEX_KEY);
  });

  it('records an empty frontend inventory without permanently completing detection', async () => {
    vi.mocked(libraryIdentityTransitionStatus).mockResolvedValue({
      serverId: INDEX_KEY,
      state: 'awaiting_supplemental_probe',
      canonicalVersion: 1,
      probeOldId: null,
      probeNewId: null,
      lastError: null,
    });
    vi.mocked(libraryIdentityTransitionProbe).mockResolvedValue({
      serverId: INDEX_KEY,
      state: 'no_legacy_ids',
      canonicalVersion: 1,
      probeOldId: null,
      probeNewId: null,
      lastError: null,
    });

    await reconcileCanonicalEntityIds({
      id: PROFILE_ID,
      name: 'Navidrome',
      url: 'https://music.test',
      username: 'user',
      password: 'password',
    }, INDEX_KEY);

    expect(libraryIdentityTransitionProbe).toHaveBeenCalledWith(INDEX_KEY, []);
    expect(libraryIdentityTransitionRunNativeMigration).not.toHaveBeenCalled();
    expect(useMigrationStore.getState().phase).toBe('completed');
  });

  it('continues bounded native probe progress without requiring manual retry', async () => {
    vi.mocked(libraryIdentityTransitionStatus).mockResolvedValue({
      serverId: INDEX_KEY,
      state: 'retryable',
      canonicalVersion: 2,
      probeOldId: null,
      probeNewId: null,
      lastError: 'canonical-ID inactive alias baseline is still progressing',
    });
    vi.mocked(libraryIdentityTransitionProbe)
      .mockResolvedValueOnce({
        serverId: INDEX_KEY,
        state: 'retryable',
        canonicalVersion: 2,
        probeOldId: null,
        probeNewId: null,
        lastError: 'canonical-ID candidate scan has more catalog rows to inspect',
      })
      .mockResolvedValueOnce({
        serverId: INDEX_KEY,
        state: 'no_legacy_ids',
        canonicalVersion: 2,
        probeOldId: null,
        probeNewId: null,
        lastError: null,
      });

    await reconcileCanonicalEntityIds({
      id: PROFILE_ID,
      name: 'Navidrome',
      url: 'https://music.test',
      username: 'user',
      password: 'password',
    }, INDEX_KEY);

    expect(libraryIdentityTransitionProbe).toHaveBeenCalledTimes(2);
    expect(useMigrationStore.getState().phase).toBe('completed');
  });

  it('acknowledges while preserving ownerless device-sync selections for later recovery', async () => {
    vi.mocked(libraryIdentityTransitionStatus).mockResolvedValue({
      serverId: INDEX_KEY,
      state: 'pending_frontend',
      canonicalVersion: 1,
      probeOldId: OLD_TRACK,
      probeNewId: NEW_TRACK,
      lastError: null,
    });
    vi.mocked(analysisClearServerCache).mockResolvedValue();
    vi.mocked(clearLyricsCache).mockResolvedValue();
    useDeviceSyncStore.setState({
      legacySources: [{ type: 'album', id: OLD_ALBUM, name: 'Legacy album' }],
    });
    useAuthStore.setState({
      skipStarManualSkipCountsByKey: {
        [`${PROFILE_ID}\u001f${OLD_TRACK}`]: 2,
        [`other-profile\u001f${OLD_TRACK}`]: 3,
      },
    });

    await reconcileCanonicalEntityIds({
      id: PROFILE_ID,
      name: 'Navidrome',
      url: 'https://music.test',
      username: 'user',
      password: 'password',
    }, INDEX_KEY);

    expect(libraryIdentityTransitionAck).toHaveBeenCalledWith(INDEX_KEY);
    expect(useDeviceSyncStore.getState().legacySources).toHaveLength(1);
    expect(useAuthStore.getState().skipStarManualSkipCountsByKey).toEqual({
      [`${PROFILE_ID}\u001f${NEW_TRACK}`]: 2,
      [`other-profile\u001f${OLD_TRACK}`]: 3,
    });
    const persistedAuth = JSON.parse(localStorage.getItem('psysonic-auth') ?? '{}') as {
      state?: { skipStarManualSkipCountsByKey?: Record<string, number> };
    };
    expect(persistedAuth.state?.skipStarManualSkipCountsByKey).toEqual({
      [`${PROFILE_ID}\u001f${NEW_TRACK}`]: 2,
      [`other-profile\u001f${OLD_TRACK}`]: 3,
    });
  });

  it('reactivates canonical owners from durable ready state after restart', async () => {
    const readyKey = 'ready.music.test';
    vi.mocked(libraryIdentityTransitionStatus).mockResolvedValue({
      serverId: readyKey,
      state: 'ready',
      canonicalVersion: 1,
      probeOldId: OLD_TRACK,
      probeNewId: NEW_TRACK,
      lastError: null,
    });

    await reconcileCanonicalEntityIds({
      id: 'ready-profile',
      name: 'Navidrome',
      url: `https://${readyKey}`,
      username: 'user',
      password: 'password',
    }, readyKey);

    expect(canonicalizeConfirmedNavidromeId(readyKey, OLD_ALBUM)).toBe(NEW_ALBUM);
  });

  it('does not acknowledge when playlist-cache persistence fails', async () => {
    vi.mocked(libraryIdentityTransitionStatus).mockResolvedValue({
      serverId: INDEX_KEY,
      state: 'pending_frontend',
      canonicalVersion: 1,
      probeOldId: OLD_TRACK,
      probeNewId: NEW_TRACK,
      lastError: null,
    });
    vi.mocked(analysisClearServerCache).mockResolvedValue();
    vi.mocked(clearLyricsCache).mockResolvedValue();
    usePlaylistStore.setState({ recentIds: [`${PROFILE_ID}:${OLD_ALBUM}`] });
    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'psysonic_playlists_recent') throw new DOMException('quota', 'QuotaExceededError');
      return originalSetItem(key, value);
    });

    await expect(reconcileCanonicalEntityIds({
      id: PROFILE_ID,
      name: 'Navidrome',
      url: 'https://music.test',
      username: 'user',
      password: 'password',
    }, INDEX_KEY)).rejects.toThrow('quota');

    setItem.mockRestore();
    expect(libraryIdentityTransitionAck).not.toHaveBeenCalled();
  });

});
