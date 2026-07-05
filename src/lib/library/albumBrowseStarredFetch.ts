import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { peekStarredAlbumBrowseCache } from './albumBrowseStarredCache';
import { refreshStarredAlbumIndexFromServer } from './starredAlbumIndexSync';
import {
  albumBrowseStarredNeedsLocalIntersect,
  filterAlbumsByCompilation,
  filterAlbumsByYearBounds,
} from './albumBrowseFilters';
import { runLocalAlbumBrowse } from './albumBrowseLocal';
import { sortSubsonicAlbums } from './albumBrowseSort';
import type {
  AlbumBrowseFetchCallbacks,
  AlbumBrowsePageResult,
  AlbumBrowseQuery,
} from './albumBrowseTypes';

function applyStarredNetworkPostFilters(
  albums: SubsonicAlbum[],
  query: AlbumBrowseQuery,
): SubsonicAlbum[] {
  let out = albums;
  if (query.year) out = filterAlbumsByYearBounds(out, query.year);
  out = filterAlbumsByCompilation(out, query.compFilter);
  if (query.starredOnly) out = out.filter(a => !!a.starred);
  return sortSubsonicAlbums(out, query.sort);
}

function paginateStarredAlbums(
  all: SubsonicAlbum[],
  query: AlbumBrowseQuery,
  offset: number,
  pageSize: number,
): AlbumBrowsePageResult {
  const filtered = applyStarredNetworkPostFilters(all, query);
  const page = filtered.slice(offset, offset + pageSize);
  return { albums: page, hasMore: offset + pageSize < filtered.length };
}

export async function fetchStarredAlbumBrowse(
  serverId: string,
  indexEnabled: boolean,
  query: AlbumBrowseQuery,
  offset: number,
  pageSize: number,
  callbacks?: AlbumBrowseFetchCallbacks,
): Promise<AlbumBrowsePageResult> {
  const emitPartial = (page: AlbumBrowsePageResult | null) => {
    if (page && offset === 0 && page.albums.length > 0) {
      callbacks?.onPartial?.(page);
    }
  };

  if (offset === 0) {
    const cached = peekStarredAlbumBrowseCache(serverId);
    if (cached?.length) {
      if (albumBrowseStarredNeedsLocalIntersect(query, indexEnabled, serverId)) {
        const fromCache = await runLocalAlbumBrowse(
          serverId,
          query,
          0,
          pageSize,
          cached.map(a => a.id),
        );
        emitPartial(fromCache);
      } else {
        emitPartial(paginateStarredAlbums(cached, query, 0, pageSize));
      }
    }
  }

  const serverAlbums = await refreshStarredAlbumIndexFromServer(serverId, indexEnabled);

  if (albumBrowseStarredNeedsLocalIntersect(query, indexEnabled, serverId)) {
    const serverIds = serverAlbums.map(a => a.id);
    const authoritative = await runLocalAlbumBrowse(serverId, query, offset, pageSize, serverIds);
    if (authoritative != null) return authoritative;
    if (query.losslessOnly) return { albums: [], hasMore: false };
  }

  return paginateStarredAlbums(serverAlbums, query, offset, pageSize);
}
