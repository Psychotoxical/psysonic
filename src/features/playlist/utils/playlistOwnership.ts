import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';

/**
 * Playlist ownership — splitting a server's flat playlist list into the three
 * buckets a user actually thinks in.
 *
 * Subsonic gives us two independent fields, and they answer different questions:
 * `owner` says *whose* playlist it is, `public` says whether it is shared. A
 * server returns your own playlists plus every public playlist of every other
 * user, so without this split someone else's shared playlists sit right between
 * your own.
 *
 * The username is **per server profile**, not global: under a multi-server scope
 * the same playlist list carries rows from several servers, each with its own
 * account. Resolving `owner` against a single "current user" would mislabel
 * every row from the other servers.
 */

/** Which bucket a playlist belongs to. */
export type PlaylistOwnershipBucket = 'personal' | 'sharedByMe' | 'sharedWithMe';

/** Header filter value; `all` disables the split. */
export type PlaylistOwnershipFilter = 'all' | PlaylistOwnershipBucket;

export const PLAYLIST_OWNERSHIP_FILTERS: readonly PlaylistOwnershipFilter[] = [
  'all',
  'personal',
  'sharedByMe',
  'sharedWithMe',
] as const;

export function isPlaylistOwnershipFilter(value: unknown): value is PlaylistOwnershipFilter {
  return typeof value === 'string'
    && (PLAYLIST_OWNERSHIP_FILTERS as readonly string[]).includes(value);
}

/** Minimal shape we need from a server profile — keeps this helper store-free. */
export interface PlaylistOwnershipServer {
  id: string;
  username?: string;
}

/**
 * True when `playlist` belongs to the account we are logged in with on *its own*
 * server.
 *
 * A playlist without an `owner` counts as ours: older servers and some Subsonic
 * implementations omit the field entirely, and treating those as foreign would
 * hide the user's own playlists behind a filter they never set.
 */
export function isOwnPlaylist(
  playlist: Pick<SubsonicPlaylist, 'owner' | 'serverId'>,
  servers: readonly PlaylistOwnershipServer[],
): boolean {
  if (!playlist.owner) return true;
  const username = servers.find(server => server.id === playlist.serverId)?.username;
  if (!username) return false;
  // Compared case-insensitively on purpose. Navidrome authenticates a Subsonic
  // login whose username differs in case from the stored one, while the record
  // it then reports as `owner` keeps the canonical spelling
  // (navidrome/navidrome#1928). A profile saved as "Tester" against an account
  // stored as "tester" is logged in perfectly well, and an exact compare would
  // file every single one of that user's playlists as someone else's.
  // The profile username is already trimmed where it is stored, so case is the
  // only difference left to absorb.
  return playlist.owner.toLowerCase() === username.toLowerCase();
}

/**
 * Classify one playlist.
 *
 * `public` only distinguishes *our* playlists — a foreign playlist is always
 * public (that is why the server sends it at all), so re-reading the flag there
 * would collapse the two shared buckets into one.
 */
export function playlistOwnershipBucket(
  playlist: Pick<SubsonicPlaylist, 'owner' | 'serverId' | 'public'>,
  servers: readonly PlaylistOwnershipServer[],
): PlaylistOwnershipBucket {
  if (!isOwnPlaylist(playlist, servers)) return 'sharedWithMe';
  return playlist.public === true ? 'sharedByMe' : 'personal';
}

/** Apply the header filter. `all` returns the input array unchanged. */
export function filterPlaylistsByOwnership<
  T extends Pick<SubsonicPlaylist, 'owner' | 'serverId' | 'public'>,
>(
  playlists: readonly T[],
  filter: PlaylistOwnershipFilter,
  servers: readonly PlaylistOwnershipServer[],
): readonly T[] {
  if (filter === 'all') return playlists;
  return playlists.filter(playlist => playlistOwnershipBucket(playlist, servers) === filter);
}

/**
 * How many playlists sit in each bucket.
 *
 * Today the only consumer is the filter's visibility rule (via
 * `hasSharedPlaylists`); the per-bucket numbers are not rendered anywhere. They
 * are kept because the rule is derived from them and reads clearer that way, and
 * because per-bucket labels are the obvious next step if they are ever wanted.
 */
export function countPlaylistsByOwnership(
  playlists: readonly Pick<SubsonicPlaylist, 'owner' | 'serverId' | 'public'>[],
  servers: readonly PlaylistOwnershipServer[],
): Record<PlaylistOwnershipBucket, number> {
  const counts: Record<PlaylistOwnershipBucket, number> = {
    personal: 0,
    sharedByMe: 0,
    sharedWithMe: 0,
  };
  for (const playlist of playlists) counts[playlistOwnershipBucket(playlist, servers)] += 1;
  return counts;
}

/**
 * Whether the filter is worth showing at all.
 *
 * On a single-user server every playlist is personal, and a control with three
 * empty buckets is noise — the same reason the folder toggle hides itself until
 * a folder exists.
 */
export function hasSharedPlaylists(
  counts: Record<PlaylistOwnershipBucket, number>,
): boolean {
  return counts.sharedByMe > 0 || counts.sharedWithMe > 0;
}
