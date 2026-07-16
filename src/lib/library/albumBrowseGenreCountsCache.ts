import type { GenreAlbumCountRow, LibraryScopePair } from '@/lib/api/library/dto';
import { libraryGetGenreAlbumCounts } from '@/lib/api/library';

function genreCountsCacheKey(serverId: string, scopes: readonly LibraryScopePair[]): string {
  return `${serverId}|${JSON.stringify(scopes.map(scope => [scope.serverId, scope.libraryId]))}`;
}

const inflight = new Map<string, Promise<GenreAlbumCountRow[]>>();

export function fetchGenreAlbumCountsDeduped(args: {
  serverId: string;
  libraryScope?: string;
  libraryScopes?: LibraryScopePair[];
}): Promise<GenreAlbumCountRow[]> {
  const scopes = args.libraryScopes
    ?? (args.libraryScope !== undefined
      ? [{ serverId: args.serverId, libraryId: args.libraryScope }]
      : [{ serverId: args.serverId, libraryId: null }]);
  const key = genreCountsCacheKey(args.serverId, scopes);
  const hit = inflight.get(key);
  if (hit) return hit;

  const promise = libraryGetGenreAlbumCounts(args);
  inflight.set(key, promise);
  return promise;
}
