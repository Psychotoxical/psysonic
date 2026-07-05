import { getArtists } from '@/lib/api/subsonicArtists';
import { getStarred } from '@/lib/api/subsonicStarRating';
import type { SubsonicArtist } from '@/lib/api/subsonicTypes';
import { libraryAdvancedSearch } from '@/lib/api/library';
import type { ArtistCreditMode } from '@/lib/api/library';
import { libraryScopeForServer, libraryScopePairsForServer } from '@/lib/api/subsonicClient';
import { libraryIsReady } from '@/lib/library/libraryReady';
import { ndListArtistsByRole } from '@/lib/api/navidromeBrowse';

/** Network artist catalog before local index is ready (#1209). */
export async function fetchNetworkArtistCatalog(
  creditMode: ArtistCreditMode,
): Promise<SubsonicArtist[]> {
  if (creditMode === 'track') {
    try {
      return await ndListArtistsByRole('performer', 0, 10_000);
    } catch {
      return getArtists();
    }
  }
  return getArtists();
}

/** Artist ids in the current credit-mode catalog (local index). */
async function fetchLocalArtistIdsForMode(
  serverId: string,
  creditMode: ArtistCreditMode,
): Promise<Set<string> | null> {
  if (!(await libraryIsReady(serverId))) return null;
  try {
    const resp = await libraryAdvancedSearch({
      serverId,
      libraryScope: libraryScopeForServer(serverId) ?? undefined,
      libraryScopes: libraryScopePairsForServer(serverId),
      entityTypes: ['artist'],
      artistCreditMode: creditMode,
      limit: 100_000,
      offset: 0,
      skipTotals: true,
    });
    if (resp.source !== 'local') return null;
    return new Set(resp.artists.map(a => a.id));
  } catch {
    return null;
  }
}

async function fetchNetworkArtistIdsForMode(
  creditMode: ArtistCreditMode,
): Promise<Set<string>> {
  return new Set((await fetchNetworkArtistCatalog(creditMode)).map(a => a.id));
}

/**
 * `getStarred2` artist slice intersected with the active credit-mode catalog
 * (album-artist index or full track performer set) — works in both modes (#1209).
 */
export async function fetchStarredArtistsForBrowse(
  creditMode: ArtistCreditMode,
  serverId: string | null | undefined,
  indexEnabled: boolean,
): Promise<SubsonicArtist[]> {
  const { artists: starredRaw } = await getStarred();
  const starred = starredRaw.map(a => ({ ...a, starred: a.starred ?? 'true' }));
  if (starred.length === 0) return starred;

  let scopeIds: Set<string> | null = null;
  if (indexEnabled && serverId) {
    scopeIds = await fetchLocalArtistIdsForMode(serverId, creditMode);
  }
  if (!scopeIds) {
    try {
      scopeIds = await fetchNetworkArtistIdsForMode(creditMode);
    } catch {
      return starred;
    }
  }
  return starred.filter(a => scopeIds!.has(a.id));
}

export function nextArtistCreditMode(mode: ArtistCreditMode): ArtistCreditMode {
  return mode === 'album' ? 'track' : 'album';
}

export type { ArtistCreditMode };
