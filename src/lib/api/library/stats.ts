/**
 * Player stats (local listening history) + genre/catalog aggregate reads. Split
 * out of the former single `lib/api/library.ts`; re-exported via the
 * `@/lib/api/library` barrel.
 */
import { invoke } from '@tauri-apps/api/core';
import { commands } from '@/generated/bindings';
import { serverIndexKeyForId, mapServerIdFromIndexKey } from './internal';
import type {
  CatalogYearBounds,
  GenreAlbumCountRow,
  LibraryGenreAlbumsRequest,
  LibraryGenreAlbumsResponse,
  PlaySessionInput,
  PlaySessionYearSummary,
  PlaySessionHeatmapDay,
  PlaySessionDayDetail,
  PlaySessionYearBounds,
  PlaySessionRecentDay,
  PlaySessionRecentTrack,
} from './dto';

export async function libraryGetCatalogYearBounds(args: {
  serverId: string;
}): Promise<CatalogYearBounds> {
  const indexKey = serverIndexKeyForId(args.serverId);
  const res = await commands.libraryGetCatalogYearBounds(indexKey);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function libraryGetGenreAlbumCounts(args: {
  serverId: string;
  libraryScope?: string;
}): Promise<GenreAlbumCountRow[]> {
  const indexKey = serverIndexKeyForId(args.serverId);
  const res = await commands.libraryGetGenreAlbumCounts(indexKey, args.libraryScope ?? null);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

/** Paginated albums for one genre from the local track index. */
export function libraryListAlbumsByGenre(
  request: LibraryGenreAlbumsRequest,
): Promise<LibraryGenreAlbumsResponse> {
  const indexKey = serverIndexKeyForId(request.serverId);
  return invoke<LibraryGenreAlbumsResponse>('library_list_albums_by_genre', {
    request: {
      serverId: indexKey,
      genre: request.genre,
      libraryScope: request.libraryScope ?? undefined,
      sort: request.sort ?? [],
      limit: request.limit ?? 50,
      offset: request.offset ?? 0,
      includeTotal: request.includeTotal ?? false,
    },
  }).then(response => ({
    ...response,
    albums: response.albums.map(album => ({
      ...album,
      serverId: mapServerIdFromIndexKey(album.serverId, request.serverId),
    })),
  }));
}

export async function libraryRecordPlaySession(input: PlaySessionInput): Promise<void> {
  const indexKey = serverIndexKeyForId(input.serverId);
  const res = await commands.libraryRecordPlaySession({ ...input, serverId: indexKey });
  if (res.status === 'error') throw new Error(res.error);
}

export async function libraryGetPlayerStatsYearSummary(year: number): Promise<PlaySessionYearSummary> {
  const res = await commands.libraryGetPlayerStatsYearSummary(year);
  if (res.status === 'error') throw new Error(res.error);
  return res.data as PlaySessionYearSummary;
}

export async function libraryGetPlayerStatsHeatmap(year: number): Promise<PlaySessionHeatmapDay[]> {
  const res = await commands.libraryGetPlayerStatsHeatmap(year);
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function libraryGetPlayerStatsDayDetail(dateIso: string): Promise<PlaySessionDayDetail> {
  const res = await commands.libraryGetPlayerStatsDayDetail(dateIso);
  if (res.status === 'error') throw new Error(res.error);
  const detail = res.data;
  return {
    ...detail,
    tracks: detail.tracks.map(track => ({
      ...track,
      serverId: mapServerIdFromIndexKey(track.serverId),
    })),
  } as PlaySessionDayDetail;
}

export async function libraryGetPlayerStatsYearBounds(): Promise<PlaySessionYearBounds> {
  const res = await commands.libraryGetPlayerStatsYearBounds();
  if (res.status === 'error') throw new Error(res.error);
  return res.data;
}

export async function libraryGetPlayerStatsRecentDays(limit = 30): Promise<PlaySessionRecentDay[]> {
  const res = await commands.libraryGetPlayerStatsRecentDays(limit);
  if (res.status === 'error') throw new Error(res.error);
  return res.data as PlaySessionRecentDay[];
}

export async function libraryGetRecentPlaySessions(args?: {
  limit?: number;
  sinceMs?: number;
}): Promise<PlaySessionRecentTrack[]> {
  const res = await commands.libraryGetRecentPlaySessions(args?.limit ?? null, args?.sinceMs ?? null);
  if (res.status === 'error') throw new Error(res.error);
  return res.data.map(row => ({
    ...row,
    serverId: mapServerIdFromIndexKey(row.serverId),
  })) as PlaySessionRecentTrack[];
}
