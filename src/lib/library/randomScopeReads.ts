import { libraryAdvancedSearch, type LibraryScopePair } from '@/lib/api/library';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { libraryScopeForServer, libraryScopePairsForServer } from '@/lib/api/subsonicClient';
import { libraryIsReady } from './libraryReady';
import { trackToSong } from './trackDtoMapping';

/** Plain random track sample from the merged local index. */
export async function runLocalRandomSongs(
  serverId: string | null | undefined,
  limit: number,
  genre?: string,
  libraryScopes?: LibraryScopePair[],
): Promise<SubsonicSong[] | null> {
  if (!serverId || !(await libraryIsReady(serverId))) return null;
  try {
    const response = await libraryAdvancedSearch({
      serverId,
      libraryScope: libraryScopeForServer(serverId) ?? undefined,
      libraryScopes: libraryScopes ?? libraryScopePairsForServer(serverId),
      entityTypes: ['track'],
      filters: genre ? [{ field: 'genre', op: 'eq', value: genre }] : [],
      sort: [{ field: 'random', dir: 'asc' }],
      limit,
      offset: 0,
      skipTotals: true,
    });
    if (response.source !== 'local') return null;
    return response.tracks.map(trackToSong);
  } catch {
    return null;
  }
}
