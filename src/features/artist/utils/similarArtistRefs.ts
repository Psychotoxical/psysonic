import type { SubsonicArtist, SubsonicArtistInfo } from '@/lib/api/subsonicTypes';

/**
 * Turn a server's `similarArtist` list into navigable artist refs.
 *
 * Artist ids are server-local, and this list arrives inside the artist info of whichever
 * server owns the artist — which under a library browse scope is not necessarily the
 * active one. Every entry must therefore carry that owner, or a click builds
 * `/artist/<owner-id>?server=<active-id>` and lands on a different artist, or on none.
 * Entries that already name their own server keep it; the active server is only the last
 * resort for the case where no owner was resolved at all.
 */
export function similarArtistRefs(
  similar: SubsonicArtistInfo['similarArtist'],
  infoServerId: string | null,
  activeServerId: string | null,
): SubsonicArtist[] {
  const owner = infoServerId ?? activeServerId ?? undefined;
  return (similar ?? []).map(sa => ({
    id: sa.id,
    name: sa.name,
    albumCount: sa.albumCount,
    serverId: 'serverId' in sa && typeof sa.serverId === 'string' ? sa.serverId : owner,
  }));
}
