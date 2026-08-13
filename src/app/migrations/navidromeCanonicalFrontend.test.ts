import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalMigrationDto } from '@/lib/api/library';
import { useAuthStore } from '@/store/authStore';
import { useLocalPlaybackStore } from '@/store/localPlaybackStore';
import { useOfflineStore } from '@/features/offline';
import { useDeviceSyncStore } from '@/features/deviceSync';
import { usePlaylistFolderStore } from '@/features/playlist/store/playlistFolderStore';
import { usePlaylistStore } from '@/features/playlist/store/playlistStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { rewriteNavidromeCanonicalFrontendState } from './navidromeCanonicalFrontend';

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

const OLD = {
  artist: 'e3b7fc2ae9447bbec37a13bf916e3cf6',
  album: 'e3b7fc2ae9447bbec37a13bf916e3cf6',
  track: 'e3b7fc2ae9447bbec37a13bf916e3cf6',
  folder: 'e3b7fc2ae9447bbec37a13bf916e3cf6',
};

const NEW = {
  artist: '6VHl3uR4kss6sUPKA8Cwnk',
  album: '6VHl3uR4kss6sUPKA8Cwnk',
  track: '6VHl3uR4kss6sUPKA8Cwnk',
  folder: '6VHl3uR4kss6sUPKA8Cwnk',
};

const migration: CanonicalMigrationDto = {
  serverId: 'music.test',
  state: 'frontend',
  canonicalVersion: 1,
  probeKind: 'track',
  probeOldId: OLD.track,
  probeNewId: NEW.track,
  lastError: null,
  mappings: (Object.keys(OLD) as Array<keyof typeof OLD>).map(entityKind => ({
    entityKind,
    oldId: OLD[entityKind],
    newId: NEW[entityKind],
  })),
};

describe('rewriteNavidromeCanonicalFrontendState', () => {
  beforeEach(() => {
    localStorage.clear();
    let manifest: unknown = null;
    invokeMock.mockReset().mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === 'read_device_manifest') return Promise.resolve(manifest);
      if (command === 'write_device_manifest') {
        manifest = {
          version: 3,
          ownerServerIndexKey: args?.ownerServerIndexKey,
          sources: args?.sources,
        };
      }
      return Promise.resolve(undefined);
    });
    useAuthStore.setState({
      servers: [{ id: 'profile', name: 'Music', url: 'https://music.test', username: 'u', password: 'p' }],
      activeServerId: 'profile',
      musicFolders: [{ id: OLD.folder, name: 'All' }],
      musicFoldersByServer: { profile: [{ id: OLD.folder, name: 'All' }] },
      libraryBrowseSelectionByServer: { profile: [OLD.folder] },
      musicLibraryFilterByServer: { profile: OLD.folder },
      musicLibrarySelectionByServer: { profile: [OLD.folder] },
      skipStarManualSkipCountsByKey: { [`profile\u001f${OLD.track}`]: 2 },
    });
    useLocalPlaybackStore.setState({
      entries: {
        [`music.test:${OLD.track}`]: {
          serverIndexKey: 'music.test',
          trackId: OLD.track,
          localPath: `/music/${OLD.track}.flac`,
          layoutFingerprint: 'layout',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 1,
          pinSource: { kind: 'album', sourceId: OLD.album },
          suffix: 'flac',
        },
      },
    });
    useOfflineStore.setState({
      albums: {
        [`music.test:${OLD.album}`]: {
          id: OLD.album,
          serverId: 'music.test',
          name: 'Album',
          artist: 'Artist',
          coverArt: `al-${OLD.album}_abcdef`,
          trackIds: [OLD.track],
          type: 'album',
        },
      },
    });
    useDeviceSyncStore.setState({
      targetDir: '/device',
      sources: [{ type: 'album', id: OLD.album, name: 'Album', serverIndexKey: 'music.test' }],
      legacySources: [{ type: 'artist', id: OLD.artist, name: 'Artist' }],
      checkedIds: [],
      pendingDeletion: [],
      deviceFilePaths: [],
      scanning: false,
    });
    usePlaylistFolderStore.setState({
      byServer: {
        profile: {
          folders: [{ id: 'folder', name: 'Folder', order: 0, collapsed: false }],
          assignments: { [OLD.album]: 'folder' },
        },
      },
      groupView: true,
    });
    usePlaylistStore.setState({
      playlists: [{
        id: OLD.album,
        serverId: 'profile',
        name: 'Playlist',
        songCount: 1,
        duration: 1,
        created: '',
        changed: '',
      }],
      recentIds: [`profile:${OLD.album}`],
      lastModified: { [`profile:${OLD.album}`]: 1 },
    });
    usePlayerStore.setState({
      queueServerId: 'music.test',
      queueItems: [{ serverId: 'music.test', trackId: OLD.track }],
      currentTrack: {
        id: OLD.track,
        title: 'Track',
        artist: 'Artist',
        album: 'Album',
        albumId: OLD.album,
        artistId: OLD.artist,
        duration: 1,
        coverArt: `mf-${OLD.track}`,
        serverId: 'music.test',
      },
    });
    localStorage.setItem('psysonic-player', JSON.stringify({
      state: {
        queueServerId: 'music.test',
        queueItems: [{ serverId: 'music.test', trackId: OLD.track }],
        currentTrack: {
          id: OLD.track,
          title: 'Track',
          artist: 'Artist',
          album: 'Album',
          albumId: OLD.album,
          artistId: OLD.artist,
          duration: 1,
          coverArt: `mf-${OLD.track}`,
          serverId: 'music.test',
        },
      },
      version: 0,
    }));
    localStorage.setItem('psysonic_shuffle_mode', JSON.stringify({
      enabled: true,
      originalOrder: [JSON.stringify(['music.test', OLD.track])],
    }));
    localStorage.setItem('psysonic_radio_favorites', JSON.stringify([`profile:${OLD.album}`]));
    localStorage.setItem('psysonic_radio_order', JSON.stringify([`profile:${OLD.album}`]));
    localStorage.setItem(
      `psy_new_releases_unread_seen_v2:${JSON.stringify([['profile', [OLD.folder]]])}`,
      JSON.stringify([OLD.album]),
    );
  });

  it('rewrites preserved state and can rerun after a crash', async () => {
    await rewriteNavidromeCanonicalFrontendState(migration);
    await rewriteNavidromeCanonicalFrontendState(migration);

    expect(useAuthStore.getState().musicFoldersByServer.profile?.[0]?.id).toBe(NEW.folder);
    expect(useLocalPlaybackStore.getState().entries[`music.test:${NEW.track}`]?.pinSource?.sourceId)
      .toBe(NEW.album);
    expect(useOfflineStore.getState().albums[`music.test:${NEW.album}`]).toMatchObject({
      id: NEW.album,
      trackIds: [NEW.track],
      coverArt: `al-${NEW.album}_abcdef`,
    });
    expect(useDeviceSyncStore.getState().sources.map(source => source.id)).toEqual([NEW.album, NEW.artist]);
    expect(useDeviceSyncStore.getState().legacySources).toEqual([]);
    expect(usePlaylistFolderStore.getState().byServer.profile?.assignments)
      .toEqual({ [NEW.album]: 'folder' });
    expect(usePlaylistStore.getState().playlists[0]?.id).toBe(NEW.album);

    const player = JSON.parse(localStorage.getItem('psysonic-player') ?? '{}');
    expect(player.state.queueItems[0].trackId).toBe(NEW.track);
    expect(player.state.currentTrack).toMatchObject({
      id: NEW.track,
      albumId: NEW.album,
      artistId: NEW.artist,
      coverArt: `mf-${NEW.track}`,
    });
    expect(invokeMock).toHaveBeenCalledWith('write_device_manifest', {
      destDir: '/device',
      ownerServerIndexKey: 'music.test',
      sources: [
        { type: 'album', id: NEW.album, name: 'Album', serverIndexKey: 'music.test' },
        { type: 'artist', id: NEW.artist, name: 'Artist', serverIndexKey: 'music.test' },
      ],
    });
    expect(localStorage.getItem('psysonic-hot-cache')).toBeNull();
    expect(JSON.parse(localStorage.getItem(
      `psy_new_releases_unread_seen_v2:${JSON.stringify([['profile', [NEW.folder]]])}`,
    ) ?? '[]')).toEqual([NEW.album]);
  });
});
