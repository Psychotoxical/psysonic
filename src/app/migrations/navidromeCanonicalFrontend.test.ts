import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalNavidromeId } from '@/lib/server/navidromeCanonicalId';
import { rewriteNavidromeCanonicalFrontendState } from './navidromeCanonicalFrontend';

const LEGACY = 'e3b7fc2ae9447bbec37a13bf916e3cf6';
const CANONICAL = '6VHl3uR4kss6sUPKA8Cwnk';
const PLAYLIST_LEGACY = '123e4567-e89b-12d3-a456-426614174000';
const PLAYLIST_CANONICAL = canonicalNavidromeId(PLAYLIST_LEGACY);
const RADIO_LEGACY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const RADIO_CANONICAL = canonicalNavidromeId(RADIO_LEGACY);

const scope = {
  serverIndexKey: 'music.test',
  profileIds: ['profile-a', 'profile-b'],
  profileServerIndexKeys: {
    'profile-a': 'music.test',
    'profile-b': 'music.test',
    other: 'other.test',
  },
};

function persisted(state: Record<string, unknown>, version = 0): string {
  return JSON.stringify({ state, version });
}

describe('rewriteNavidromeCanonicalFrontendState', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('psysonic-auth', persisted({
      activeServerId: 'profile-a',
      servers: [
        { id: 'profile-a', url: 'https://music.test' },
        { id: 'profile-b', url: 'https://music.test' },
        { id: 'other', url: 'https://other.test' },
      ],
      musicFolders: [{ id: LEGACY, name: 'All' }],
      musicFoldersByServer: {
        'profile-a': [{ id: LEGACY, name: 'All' }],
        'profile-b': [{ id: LEGACY, name: 'All' }],
      },
      libraryBrowseSelectionByServer: { 'profile-a': [LEGACY] },
      musicLibraryFilterByServer: { 'profile-a': LEGACY },
      musicLibrarySelectionByServer: { 'profile-a': [LEGACY] },
      skipStarManualSkipCountsByKey: {
        [`profile-a\u001f${LEGACY}`]: 2,
        [`profile-a\u001f${CANONICAL}`]: 4,
        [`other\u001f${LEGACY}`]: 3,
        malformed: 8,
        [`removed\u001f${LEGACY}`]: 9,
      },
    }, 1));
    localStorage.setItem('psysonic-player', persisted({
      queueServerId: 'music.test',
      queueItems: [{ serverId: 'music.test', trackId: LEGACY }],
      currentTrack: {
        id: LEGACY,
        albumId: LEGACY,
        artistId: LEGACY,
        coverArt: `mf-${LEGACY}`,
        serverId: 'music.test',
      },
    }));
    localStorage.setItem('psysonic_shuffle_mode', JSON.stringify({
      enabled: true,
      originalOrder: [LEGACY, JSON.stringify(['music.test', LEGACY])],
    }));
    localStorage.setItem('psysonic-local-playback', persisted({
      entries: {
        [`music.test:${LEGACY}`]: {
          serverIndexKey: 'music.test',
          trackId: LEGACY,
          localPath: `/cache/${LEGACY}.flac`,
          layoutFingerprint: 'layout',
          sizeBytes: 1,
          tier: 'library',
          cachedAt: 2,
          pinSource: { kind: 'album', sourceId: LEGACY },
          pinSources: [
            { kind: 'artist', sourceId: LEGACY },
            { kind: 'playlist', sourceId: PLAYLIST_LEGACY },
          ],
          suffix: 'flac',
        },
      },
    }, 1));
    localStorage.setItem('psysonic-offline', persisted({
      tracks: {
        [`profile-a:${LEGACY}`]: {
          id: LEGACY,
          serverId: 'profile-a',
          localPath: `/cache/${LEGACY}.flac`,
          title: 'Track',
          artist: 'Artist',
          album: 'Album',
          albumId: LEGACY,
          artistId: LEGACY,
          suffix: 'flac',
          duration: 60,
          coverArt: `al-${LEGACY}`,
          cachedAt: '2026-08-01T00:00:00.000Z',
        },
      },
      albums: {
        [`music.test:${LEGACY}`]: {
          id: LEGACY,
          serverId: 'music.test',
          name: 'Album',
          artist: 'Artist',
          coverArt: `al-${LEGACY}_abcdef`,
          trackIds: [LEGACY],
          type: 'album',
        },
        [`profile-a:playlist-${PLAYLIST_LEGACY}`]: {
          id: PLAYLIST_LEGACY,
          serverId: 'profile-a',
          name: 'Playlist pin',
          artist: '',
          coverArt: `pl-${PLAYLIST_LEGACY}`,
          trackIds: [LEGACY],
          type: 'playlist',
        },
      },
    }));
    localStorage.setItem('psysonic-hot-cache', persisted({ entries: { [LEGACY]: {} } }));
    localStorage.setItem('psysonic_device_sync', persisted({
      targetDir: '/device',
      sources: [
        { type: 'album', id: LEGACY, name: 'Album', serverIndexKey: 'music.test' },
        { type: 'album', id: CANONICAL, name: '', note: 'canonical metadata', serverIndexKey: 'music.test' },
        { type: 'playlist', id: PLAYLIST_LEGACY, name: 'Playlist', serverIndexKey: 'profile-a' },
      ],
      legacySources: [{ type: 'artist', id: LEGACY, name: 'Unassigned' }],
    }, 2));
    localStorage.setItem('psysonic_playlists_recent', persisted({
      playlists: [{ id: PLAYLIST_LEGACY, serverId: 'profile-a', name: 'Playlist', coverArt: `pl-${PLAYLIST_LEGACY}` }],
      recentIds: [`profile-a:${PLAYLIST_LEGACY}`],
      lastModified: { [`profile-a:${PLAYLIST_LEGACY}`]: 10 },
    }, 1));
    localStorage.setItem('psysonic_playlist_folders', persisted({
      byServer: {
        'profile-a': {
          folders: [{ id: 'local-folder', name: 'Folder' }],
          assignments: { [PLAYLIST_LEGACY]: 'local-folder' },
        },
      },
    }));
    localStorage.setItem('psysonic_radio_favorites', JSON.stringify([`profile-a:${RADIO_LEGACY}`]));
    localStorage.setItem('psysonic_radio_order', JSON.stringify([`profile-a:${RADIO_LEGACY}`]));
    localStorage.setItem(
      `psy_new_releases_unread_seen_v2:${JSON.stringify([['profile-a', [LEGACY]]])}`,
      JSON.stringify([LEGACY]),
    );
    localStorage.setItem('psysonic_because_anchor_history:music.test', JSON.stringify([LEGACY]));
  });

  it('rewrites every declared raw persistence surface idempotently before hydration', () => {
    rewriteNavidromeCanonicalFrontendState(scope);
    rewriteNavidromeCanonicalFrontendState(scope);

    const auth = JSON.parse(localStorage.getItem('psysonic-auth') ?? '{}').state;
    expect(auth.musicFoldersByServer['profile-a'][0].id).toBe(CANONICAL);
    expect(auth.musicFoldersByServer['profile-b'][0].id).toBe(CANONICAL);
    expect(auth.skipStarManualSkipCountsByKey).toEqual({
      [`profile-a\u001f${CANONICAL}`]: 4,
      [`other\u001f${LEGACY}`]: 3,
    });

    const player = JSON.parse(localStorage.getItem('psysonic-player') ?? '{}').state;
    expect(player.queueItems[0].trackId).toBe(CANONICAL);
    expect(player.currentTrack).toMatchObject({
      id: CANONICAL,
      albumId: CANONICAL,
      artistId: CANONICAL,
      coverArt: `mf-${CANONICAL}`,
    });
    expect(JSON.parse(localStorage.getItem('psysonic_shuffle_mode') ?? '{}').originalOrder).toEqual([
      CANONICAL,
      JSON.stringify(['music.test', CANONICAL]),
    ]);

    const local = JSON.parse(localStorage.getItem('psysonic-local-playback') ?? '{}').state.entries;
    expect(local[`music.test:${CANONICAL}`]).toMatchObject({
      trackId: CANONICAL,
      localPath: `/cache/${CANONICAL}.flac`,
      pinSource: { sourceId: CANONICAL },
    });
    expect(local[`music.test:${CANONICAL}`].pinSources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'album', sourceId: CANONICAL }),
      expect.objectContaining({ kind: 'artist', sourceId: CANONICAL }),
      expect.objectContaining({ kind: 'playlist', sourceId: PLAYLIST_CANONICAL }),
    ]));
    const offline = JSON.parse(localStorage.getItem('psysonic-offline') ?? '{}').state.albums;
    expect(offline[`music.test:${CANONICAL}`]).toMatchObject({
      id: CANONICAL,
      trackIds: [CANONICAL],
      coverArt: `al-${CANONICAL}_abcdef`,
    });
    expect(offline[`music.test:${PLAYLIST_CANONICAL}`]).toMatchObject({
      id: PLAYLIST_CANONICAL,
      serverId: 'music.test',
      trackIds: [CANONICAL],
      coverArt: `pl-${PLAYLIST_CANONICAL}`,
      type: 'playlist',
    });
    const offlineTracks = JSON.parse(localStorage.getItem('psysonic-offline') ?? '{}').state.tracks;
    expect(offlineTracks[`music.test:${CANONICAL}`]).toMatchObject({
      id: CANONICAL,
      serverId: 'music.test',
      albumId: CANONICAL,
      artistId: CANONICAL,
      localPath: `/cache/${CANONICAL}.flac`,
    });

    const device = JSON.parse(localStorage.getItem('psysonic_device_sync') ?? '{}').state;
    expect(device.sources).toHaveLength(2);
    expect(device.sources[0]).toMatchObject({
      type: 'album', id: CANONICAL, name: 'Album', note: 'canonical metadata',
    });
    expect(device.sources[1]).toMatchObject({
      type: 'playlist', id: PLAYLIST_CANONICAL, serverIndexKey: 'music.test',
    });
    expect(device.legacySources[0].id).toBe(LEGACY);
    const playlists = JSON.parse(localStorage.getItem('psysonic_playlists_recent') ?? '{}').state;
    expect(playlists.playlists[0]).toMatchObject({
      id: PLAYLIST_CANONICAL,
      coverArt: `pl-${PLAYLIST_CANONICAL}`,
    });
    expect(playlists.recentIds).toEqual([`profile-a:${PLAYLIST_CANONICAL}`]);
    expect(playlists.lastModified).toEqual({ [`profile-a:${PLAYLIST_CANONICAL}`]: 10 });
    expect(JSON.parse(localStorage.getItem('psysonic_playlist_folders') ?? '{}').state.byServer['profile-a'].assignments)
      .toEqual({ [PLAYLIST_CANONICAL]: 'local-folder' });
    expect(JSON.parse(localStorage.getItem('psysonic_radio_favorites') ?? '[]'))
      .toEqual([`profile-a:${RADIO_CANONICAL}`]);
    expect(JSON.parse(localStorage.getItem('psysonic_radio_order') ?? '[]'))
      .toEqual([`profile-a:${RADIO_CANONICAL}`]);
    expect(JSON.parse(localStorage.getItem(
      `psy_new_releases_unread_seen_v2:${JSON.stringify([['profile-a', [CANONICAL]]])}`,
    ) ?? '[]')).toEqual([CANONICAL]);
    expect(localStorage.getItem('psysonic-hot-cache')).toBeNull();
    expect(localStorage.getItem('psysonic-local-playback-migrated-v1')).toBe('1');
    expect(localStorage.getItem('psysonic_because_anchor_history:music.test')).toBeNull();
  });

  it('blocks conflicting local playback destinations instead of deleting either path', () => {
    localStorage.setItem('psysonic-local-playback', persisted({
      entries: {
        legacy: {
          serverIndexKey: 'music.test', trackId: LEGACY, localPath: `/cache/${LEGACY}.flac`,
          layoutFingerprint: 'a', sizeBytes: 1, tier: 'library', cachedAt: 1, suffix: 'flac',
        },
        canonical: {
          serverIndexKey: 'music.test', trackId: CANONICAL, localPath: `/cache/other.flac`,
          layoutFingerprint: 'b', sizeBytes: 1, tier: 'library', cachedAt: 2, suffix: 'flac',
        },
      },
    }, 1));

    expect(() => rewriteNavidromeCanonicalFrontendState(scope))
      .toThrow(`Local playback collision at music.test:${CANONICAL}`);
    expect(localStorage.getItem('psysonic-local-playback-migrated-v1')).toBeNull();
  });

  it('imports durable legacy offline tracks before disabling the hydration importer', () => {
    localStorage.removeItem('psysonic-local-playback');

    rewriteNavidromeCanonicalFrontendState(scope);

    const entries = JSON.parse(localStorage.getItem('psysonic-local-playback') ?? '{}').state.entries;
    expect(entries[`music.test:${CANONICAL}`]).toMatchObject({
      serverIndexKey: 'music.test',
      trackId: CANONICAL,
      localPath: `/cache/${CANONICAL}.flac`,
      tier: 'library',
    });
    expect(localStorage.getItem('psysonic-local-playback-migrated-v1')).toBe('1');
  });

  it('invalidates legacy hot-cache persistence without promoting ephemeral entries', () => {
    localStorage.removeItem('psysonic-local-playback');
    localStorage.setItem('psysonic-offline', persisted({ albums: {} }));
    localStorage.setItem('psysonic-hot-cache', persisted({
      entries: {
        [`profile-a:${LEGACY}`]: {
          localPath: `/hot/${LEGACY}.mp3`, sizeBytes: 10, cachedAt: 1,
        },
      },
    }));

    rewriteNavidromeCanonicalFrontendState(scope);

    expect(localStorage.getItem('psysonic-local-playback')).toBeNull();
    expect(localStorage.getItem('psysonic-hot-cache')).toBeNull();
    expect(localStorage.getItem('psysonic-local-playback-migrated-v1')).toBe('1');
  });
});
