import type { GenreAlbumCountRow } from '@/lib/api/library/dto';
import { libraryGetGenreAlbumCounts } from '@/lib/api/library';

function genreCountsCacheKey(serverId: string, scopes: readonly string[]): string {
  return `${serverId}|${[...scopes].sort().join('\u0001')}`;
}

const inflight = new Map<string, Promise<GenreAlbumCountRow[]>>();

export function fetchGenreAlbumCountsDeduped(args: {
  serverId: string;
  libraryScope?: string;
  libraryScopes?: string[];
}): Promise<GenreAlbumCountRow[]> {
  const scopes = args.libraryScopes ?? (args.libraryScope ? [args.libraryScope] : []);
  const key = genreCountsCacheKey(args.serverId, scopes);
  const hit = inflight.get(key);
  if (hit) return hit;

  const promise = libraryGetGenreAlbumCounts(args);
  inflight.set(key, promise);
  return promise;
}
