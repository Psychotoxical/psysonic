import { describe, expect, it } from 'vitest';
import {
  countPlaylistsByOwnership,
  filterPlaylistsByOwnership,
  hasSharedPlaylists,
  isOwnPlaylist,
  isPlaylistOwnershipFilter,
  playlistOwnershipBucket,
  type PlaylistOwnershipServer,
} from '@/features/playlist/utils/playlistOwnership';

const servers: PlaylistOwnershipServer[] = [
  { id: 'srv-1', username: 'tester' },
  { id: 'srv-2', username: 'alice' },
];

const pl = (over: Partial<{ owner: string; serverId: string; public: boolean }> = {}) => ({
  owner: undefined as string | undefined,
  serverId: 'srv-1',
  public: undefined as boolean | undefined,
  ...over,
});

describe('isOwnPlaylist', () => {
  it('treats a playlist without an owner as ours', () => {
    // Older servers omit the field; calling those foreign would hide the
    // user's own playlists behind a filter they never set.
    expect(isOwnPlaylist(pl({ owner: undefined }), servers)).toBe(true);
  });

  it('matches the owner against the username of its own server profile', () => {
    expect(isOwnPlaylist(pl({ owner: 'tester', serverId: 'srv-1' }), servers)).toBe(true);
    expect(isOwnPlaylist(pl({ owner: 'alice', serverId: 'srv-1' }), servers)).toBe(false);
  });

  it('resolves the same owner name differently per server', () => {
    // The multi-server trap: one flat list carries rows from several servers,
    // each with its own account. A single global username would mislabel one
    // of these two.
    expect(isOwnPlaylist(pl({ owner: 'alice', serverId: 'srv-2' }), servers)).toBe(true);
    expect(isOwnPlaylist(pl({ owner: 'tester', serverId: 'srv-2' }), servers)).toBe(false);
  });

  it('does not claim a playlist whose server profile is unknown', () => {
    expect(isOwnPlaylist(pl({ owner: 'tester', serverId: 'srv-gone' }), servers)).toBe(false);
  });

  it('does not claim a playlist when the profile carries no username', () => {
    expect(isOwnPlaylist(pl({ owner: 'tester' }), [{ id: 'srv-1' }])).toBe(false);
  });

  it('ignores letter case, because the server logs the user in regardless of it', () => {
    // navidrome/navidrome#1928: a Subsonic login whose case differs from the
    // stored account authenticates fine, but the server keeps reporting the
    // canonical spelling as `owner`.
    const profiles: PlaylistOwnershipServer[] = [{ id: 'srv-1', username: 'Tester' }];
    expect(isOwnPlaylist(pl({ owner: 'tester' }), profiles)).toBe(true);
    expect(isOwnPlaylist(pl({ owner: 'TESTER' }), profiles)).toBe(true);
    expect(isOwnPlaylist(pl({ owner: 'someone-else' }), profiles)).toBe(false);
  });

  it('classifies a case-mismatched own playlist as personal, not shared', () => {
    // The whole point: without this the page would file every playlist of that
    // user under "shared with me" and show the filter on a single-user server.
    const profiles: PlaylistOwnershipServer[] = [{ id: 'srv-1', username: 'Tester' }];
    expect(playlistOwnershipBucket(pl({ owner: 'tester' }), profiles)).toBe('personal');
    expect(countPlaylistsByOwnership([pl({ owner: 'tester' })], profiles))
      .toEqual({ personal: 1, sharedByMe: 0, sharedWithMe: 0 });
  });
});

describe('playlistOwnershipBucket', () => {
  it('files an own private playlist as personal', () => {
    expect(playlistOwnershipBucket(pl({ owner: 'tester', public: false }), servers)).toBe('personal');
  });

  it('treats a missing public flag as private', () => {
    expect(playlistOwnershipBucket(pl({ owner: 'tester' }), servers)).toBe('personal');
  });

  it('files an own public playlist as shared by me', () => {
    expect(playlistOwnershipBucket(pl({ owner: 'tester', public: true }), servers)).toBe('sharedByMe');
  });

  it('files a foreign public playlist as shared with me, not shared by me', () => {
    // Every foreign playlist the server hands us is public — that is why it
    // arrives at all. Reading the flag there would collapse both shared buckets.
    expect(playlistOwnershipBucket(pl({ owner: 'bob', public: true }), servers)).toBe('sharedWithMe');
  });

  it('files a foreign playlist as shared with me even without the public flag', () => {
    expect(playlistOwnershipBucket(pl({ owner: 'bob' }), servers)).toBe('sharedWithMe');
  });
});

describe('filterPlaylistsByOwnership', () => {
  const list = [
    pl({ owner: 'tester', public: false }),
    pl({ owner: 'tester', public: true }),
    pl({ owner: 'bob', public: true }),
    pl({ owner: undefined }),
  ];

  it('returns the input untouched for "all"', () => {
    expect(filterPlaylistsByOwnership(list, 'all', servers)).toBe(list);
  });

  it('keeps only the requested bucket', () => {
    expect(filterPlaylistsByOwnership(list, 'personal', servers)).toHaveLength(2);
    expect(filterPlaylistsByOwnership(list, 'sharedByMe', servers)).toHaveLength(1);
    expect(filterPlaylistsByOwnership(list, 'sharedWithMe', servers)).toHaveLength(1);
  });

  it('can return an empty bucket', () => {
    const onlyPersonal = [pl({ owner: 'tester' })];
    expect(filterPlaylistsByOwnership(onlyPersonal, 'sharedWithMe', servers)).toEqual([]);
  });
});

describe('countPlaylistsByOwnership / hasSharedPlaylists', () => {
  it('counts every bucket', () => {
    const counts = countPlaylistsByOwnership([
      pl({ owner: 'tester' }),
      pl({ owner: 'tester', public: true }),
      pl({ owner: 'bob', public: true }),
      pl({ owner: 'bob', public: true }),
    ], servers);
    expect(counts).toEqual({ personal: 1, sharedByMe: 1, sharedWithMe: 2 });
  });

  it('reports nothing shared on a single-user server', () => {
    const counts = countPlaylistsByOwnership([pl({ owner: 'tester' }), pl()], servers);
    expect(counts).toEqual({ personal: 2, sharedByMe: 0, sharedWithMe: 0 });
    expect(hasSharedPlaylists(counts)).toBe(false);
  });

  it('reports shared when either shared bucket is populated', () => {
    expect(hasSharedPlaylists({ personal: 1, sharedByMe: 1, sharedWithMe: 0 })).toBe(true);
    expect(hasSharedPlaylists({ personal: 1, sharedByMe: 0, sharedWithMe: 1 })).toBe(true);
  });
});

describe('isPlaylistOwnershipFilter', () => {
  it('accepts the four known values and rejects anything else', () => {
    for (const value of ['all', 'personal', 'sharedByMe', 'sharedWithMe']) {
      expect(isPlaylistOwnershipFilter(value)).toBe(true);
    }
    for (const value of ['', 'shared', 'PERSONAL', null, undefined, 3, {}]) {
      expect(isPlaylistOwnershipFilter(value)).toBe(false);
    }
  });
});

describe('deletability parity', () => {
  // `Playlists.tsx` used to inline this logic. It now composes the shared
  // helper, so pin the equivalence deterministically instead of trusting that
  // the rewrite was faithful.
  const previousImplementation = (
    playlist: { owner?: string; serverId?: string },
    profiles: PlaylistOwnershipServer[],
  ): boolean => {
    if (!playlist.serverId) return false;
    if (!playlist.owner) return true;
    const username = profiles.find(server => server.id === playlist.serverId)?.username;
    return Boolean(username) && playlist.owner === username;
  };

  const current = (
    playlist: { owner?: string; serverId?: string },
    profiles: PlaylistOwnershipServer[],
  ): boolean => Boolean(playlist.serverId) && isOwnPlaylist(playlist, profiles);

  it('agrees with the previous inline implementation wherever case matches', () => {
    const owners = [undefined, 'tester', 'alice', 'bob'];
    const serverIds = [undefined, 'srv-1', 'srv-2', 'srv-gone'];
    const profileSets: PlaylistOwnershipServer[][] = [servers, [{ id: 'srv-1' }], []];

    let compared = 0;
    for (const owner of owners) {
      for (const serverId of serverIds) {
        for (const profiles of profileSets) {
          const playlist = { owner, serverId };
          expect(current(playlist, profiles)).toBe(previousImplementation(playlist, profiles));
          compared += 1;
        }
      }
    }
    // Guard the guard: a typo in the loops must not silently assert nothing.
    expect(compared).toBe(owners.length * serverIds.length * profileSets.length);
  });

  it('deliberately diverges from it on a case mismatch', () => {
    // The one intended behaviour change: the old compare denied these users the
    // delete button on their own playlists. Pinned so the divergence stays a
    // decision rather than becoming an accident later.
    const profiles: PlaylistOwnershipServer[] = [{ id: 'srv-1', username: 'Tester' }];
    const playlist = { owner: 'tester', serverId: 'srv-1' };
    expect(previousImplementation(playlist, profiles)).toBe(false);
    expect(current(playlist, profiles)).toBe(true);
  });
});
