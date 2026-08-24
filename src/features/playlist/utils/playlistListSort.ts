import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';

/**
 * Ordering for the playlist *list* — the sidebar section and the Playlists page.
 *
 * Not to be confused with `PlaylistSortKey` in `playlistDisplayedSongs`, which
 * orders the songs inside one playlist. Both surfaces here share a single
 * persisted choice, so the list reads the same wherever it appears.
 *
 * Only keys the server actually delivers in the playlist listing are offered.
 * "Last played" is deliberately absent: `play_session` records a track and a
 * timestamp but no playlist, so the database cannot say which playlist a track
 * was started from. Offering it would need a new column and a migration.
 */
export type PlaylistListSortKey = 'name' | 'created' | 'songCount';

export const PLAYLIST_LIST_SORT_KEYS: readonly PlaylistListSortKey[] = [
  'name',
  'created',
  'songCount',
] as const;

export const DEFAULT_PLAYLIST_LIST_SORT: PlaylistListSortKey = 'name';

export function isPlaylistListSortKey(value: unknown): value is PlaylistListSortKey {
  return typeof value === 'string'
    && (PLAYLIST_LIST_SORT_KEYS as readonly string[]).includes(value);
}

type SortablePlaylist = Pick<SubsonicPlaylist, 'name' | 'created' | 'songCount'>;

/** Epoch ms for an ISO timestamp; unparsable or missing sorts oldest. */
function createdAtMs(playlist: SortablePlaylist): number {
  const parsed = Date.parse(playlist.created ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Order `playlists` by `key`, newest and largest first for the two numeric
 * keys — asking for "by date created" means wanting the recent ones up top.
 *
 * Ties fall back to the name so the order never wobbles between renders: two
 * playlists created in the same second, or with the same song count, would
 * otherwise swap places on every re-sort.
 */
export function sortPlaylistList<T extends SortablePlaylist>(
  playlists: readonly T[],
  key: PlaylistListSortKey,
): T[] {
  const byName = (a: T, b: T) => (a.name ?? '').localeCompare(b.name ?? '');
  const sorted = [...playlists];
  switch (key) {
    case 'created':
      return sorted.sort((a, b) => createdAtMs(b) - createdAtMs(a) || byName(a, b));
    case 'songCount':
      return sorted.sort((a, b) => (b.songCount ?? 0) - (a.songCount ?? 0) || byName(a, b));
    case 'name':
    default:
      return sorted.sort(byName);
  }
}
