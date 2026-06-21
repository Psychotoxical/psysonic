/**
 * Typed wrappers around the `library_*` Tauri commands (spec §7.1) plus
 * subscribers for `library:sync-progress` / `library:sync-idle` events
 * (§7.2). One thin file per cucadmuh's PR-5 kickoff Q1 — Settings UI
 * (LibraryTab) imports from here; nothing else in the app talks to the
 * backend library surface directly.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useAuthStore } from '../store/authStore';
import { serverIndexKeyFromUrl } from '../utils/server/serverIndexKey';
import { resolveServerIdForIndexKey } from '../utils/server/serverLookup';

// ── DTO mirrors (camelCase, matching the Rust `#[serde(rename_all = "camelCase")]`) ─

export interface TrackRefDto {
  serverId: string;
  trackId: string;
  contentHash?: string | null;
}

/** E3 readiness summary — present only on single-track `libraryGetTrack` reads. */
export interface TrackEnrichmentDto {
  waveformReady: boolean;
  loudnessReady: boolean;
  lyricsCached: boolean;
}

export interface LibraryTrackDto {
  serverId: string;
  id: string;
  contentHash?: string | null;
  title: string;
  titleSort?: string | null;
  artist?: string | null;
  artistId?: string | null;
  album: string;
  albumId?: string | null;
  albumArtist?: string | null;
  durationSec: number;
  trackNumber?: number | null;
  discNumber?: number | null;
  year?: number | null;
  genre?: string | null;
  suffix?: string | null;
  bitRate?: number | null;
  sizeBytes?: number | null;
  coverArtId?: string | null;
  starredAt?: number | null;
  userRating?: number | null;
  playCount?: number | null;
  playedAt?: number | null;
  serverPath?: string | null;
  libraryId?: string | null;
  isrc?: string | null;
  mbidRecording?: string | null;
  bpm?: number | null;
  /** `'analysis'` | `'tag'` — Advanced Search BPM dual-storage projection only. */
  bpmSource?: string | null;
  replayGainTrackDb?: number | null;
  replayGainAlbumDb?: number | null;
  serverUpdatedAt?: number | null;
  serverCreatedAt?: number | null;
  syncedAt: number;
  /** E3: populated only by `libraryGetTrack` (omitted on list/batch reads). */
  enrichment?: TrackEnrichmentDto | null;
  rawJson: unknown;
}

export interface SyncStateDto {
  serverId: string;
  libraryScope: string;
  syncPhase: string;
  capabilityFlags: number;
  libraryTier: string;
  lastFullSyncAt?: number | null;
  lastDeltaSyncAt?: number | null;
  nextPollAt?: number | null;
  serverLastScanIso?: string | null;
  indexesLastModifiedMs?: number | null;
  artistsLastModifiedMs?: number | null;
  ignoredArticles?: string | null;
  localTrackCount?: number | null;
  serverTrackCount?: number | null;
  lastError?: string | null;
  localTracksMaxUpdatedMs?: number | null;
  /** True when at least one non-deleted track exists locally (cheap EXISTS). */
  hasLocalTracks?: boolean;
  ingestStrategy?: string | null;
  ingestPhase?: string | null;
  /** Tracks ingested per persisted initial-sync cursor (IS-3 progress). */
  cursorIngestedCount?: number | null;
  n1BulkUnreliable?: boolean | null;
}

export interface LibraryTracksEnvelope {
  tracks: LibraryTrackDto[];
  total: number;
}

export interface TrackArtifactDto {
  serverId: string;
  trackId: string;
  artifactKind: string;
  format: string;
  sourceKind: string;
  sourceId: string;
  language?: string | null;
  contentText?: string | null;
  contentBytes: number;
  notFound: boolean;
  contentHash?: string | null;
  fetchedAt: number;
  expiresAt?: number | null;
}

export interface ArtifactInputDto {
  artifactKind: string;
  format: string;
  sourceKind: string;
  sourceId: string;
  language?: string | null;
  contentText?: string | null;
  contentBlob?: number[] | null;
  contentBytes?: number;
  notFound?: boolean;
  contentHash?: string | null;
  expiresAt?: number | null;
}

export interface TrackFactDto {
  serverId: string;
  trackId: string;
  factKind: string;
  valueReal?: number | null;
  valueInt?: number | null;
  valueText?: string | null;
  unit?: string | null;
  sourceKind: string;
  sourceId: string;
  confidence: number;
  contentHash?: string | null;
  fetchedAt: number;
  expiresAt?: number | null;
}

export interface FactInputDto {
  factKind: string;
  valueReal?: number | null;
  valueInt?: number | null;
  valueText?: string | null;
  unit?: string | null;
  sourceKind: string;
  sourceId: string;
  confidence?: number;
  contentHash?: string | null;
  expiresAt?: number | null;
}

export interface OfflinePathDto {
  serverId: string;
  trackId: string;
  localPath?: string | null;
  missing: boolean;
}

export interface PurgeReportDto {
  tracksDeleted: number;
  albumsDeleted: number;
  artistsDeleted: number;
  offlineRowsDeleted: number;
  bytesFreed: number;
}

export interface SyncJobDto {
  jobId: string;
  serverId: string;
  kind: string; // 'initial_sync' | 'delta_sync'
}

// ── Advanced Search (PR-5d, §5.13 / §5.5B) ────────────────────────────

export type LibraryEntityType = 'artist' | 'album' | 'track';

/** v1 operator set the Rust `FilterFieldRegistry` accepts (§5.13.2). */
export type FilterOperator = 'eq' | 'gte' | 'lte' | 'between' | 'fts' | 'is_true' | 'in';

export type SortDir = 'asc' | 'desc';

export interface LibraryFilterClause {
  field: string; // registry id, e.g. 'genre' | 'year' | 'bpm'
  op: FilterOperator;
  value?: string | number | boolean | null;
  valueTo?: number | null; // between: inclusive upper bound
}

export interface LibrarySortClause {
  field: string;
  dir: SortDir;
}

export interface LibraryAdvancedSearchRequest {
  serverId: string;
  libraryScope?: string | null;
  query?: string | null; // shorthand → fts clause on text fields
  entityTypes: LibraryEntityType[];
  filters?: LibraryFilterClause[];
  starredOnly?: boolean | null;
  /** Server favorites ids ∩ local filters (lossless, genre, year). */
  restrictAlbumIds?: string[] | null;
  sort?: LibrarySortClause[];
  limit: number;
  offset?: number;
  /** Skip expensive COUNT queries (Live Search). */
  skipTotals?: boolean;
  /** Album text query matches title/name only (All Albums scoped browse). */
  queryAlbumTitleOnly?: boolean | null;
}

export interface LibraryAlbumDto {
  serverId: string;
  id: string;
  name: string;
  artist?: string | null;
  artistId?: string | null;
  songCount?: number | null;
  durationSec?: number | null;
  year?: number | null;
  genre?: string | null;
  coverArtId?: string | null;
  starredAt?: number | null;
  syncedAt: number;
  rawJson: unknown;
}

export interface LibraryArtistDto {
  serverId: string;
  id: string;
  name: string;
  nameSort?: string | null;
  albumCount?: number | null;
  syncedAt: number;
  rawJson: unknown;
}

export interface LibrarySearchTotals {
  artists: number;
  albums: number;
  tracks: number;
}

export interface LibraryAdvancedSearchResponse {
  artists: LibraryArtistDto[];
  albums: LibraryAlbumDto[];
  tracks: LibraryTrackDto[];
  totals: LibrarySearchTotals;
  /** Registry field ids actually applied — UI chips / debug. */
  appliedFilters: string[];
  source: 'local' | 'network' | 'mixed';
}

export interface LibraryCrossServerSearchResponse {
  hits: LibraryTrackDto[];
  /** Fuzzy `title LIKE` matches the exact FTS pass missed (§5.9 / H3). */
  fuzzy: LibraryTrackDto[];
  serversSearched: string[];
}

function serverIndexKeyForId(serverId: string): string {
  const server = useAuthStore.getState().servers.find(s => s.id === serverId);
  if (!server) return serverId;
  return serverIndexKeyFromUrl(server.url) || serverId;
}

function mapServerIdFromIndexKey(serverId: string, fallback?: string): string {
  if (fallback) return fallback;
  return resolveServerIdForIndexKey(serverId);
}

function mapTracksServerId(
  tracks: LibraryTrackDto[],
  fallbackServerId?: string,
): LibraryTrackDto[] {
  if (tracks.length === 0) return tracks;
  return tracks.map(track => ({
    ...track,
    serverId: mapServerIdFromIndexKey(track.serverId, fallbackServerId),
  }));
}

// ── Read commands (PR-5a) ─────────────────────────────────────────────

export function libraryGetStatus(
  serverId: string,
  libraryScope?: string,
): Promise<SyncStateDto> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<SyncStateDto>('library_get_status', { serverId: indexKey, libraryScope })
    .then(status => ({ ...status, serverId }));
}

export function librarySearch(
  serverId: string,
  query: string,
  options?: { limit?: number; offset?: number; libraryScope?: string },
): Promise<LibraryTracksEnvelope> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<LibraryTracksEnvelope>('library_search', {
    serverId: indexKey,
    query,
    limit: options?.limit,
    offset: options?.offset,
    libraryScope: options?.libraryScope,
  }).then(envelope => ({
    ...envelope,
    tracks: mapTracksServerId(envelope.tracks, serverId),
  }));
}

/**
 * Advanced Search against the local index (§5.13). The frontend fallback
 * (PR-7 F2) decides local vs network and maps the same `LibraryFilterClause`
 * shape onto the network path; this wrapper only talks to the local builder.
 */
export function libraryAdvancedSearch(
  request: LibraryAdvancedSearchRequest,
): Promise<LibraryAdvancedSearchResponse> {
  const indexKey = serverIndexKeyForId(request.serverId);
  return invoke<LibraryAdvancedSearchResponse>('library_advanced_search', {
    request: { ...request, serverId: indexKey },
  }).then(response => ({
    ...response,
    artists: response.artists.map(artist => ({
      ...artist,
      serverId: mapServerIdFromIndexKey(artist.serverId, request.serverId),
    })),
    albums: response.albums.map(album => ({
      ...album,
      serverId: mapServerIdFromIndexKey(album.serverId, request.serverId),
    })),
    tracks: mapTracksServerId(response.tracks, request.serverId),
  }));
}

export interface LibraryLiveSearchResponse {
  artists: LibraryArtistDto[];
  albums: LibraryAlbumDto[];
  tracks: LibraryTrackDto[];
  source: 'local' | 'network' | 'mixed';
}

/** Live Search dropdown — one lean FTS query (§5.9), not Advanced Search. */
export interface LibraryLiveSearchRequest {
  serverId: string;
  query: string;
  /** Subsonic `musicFolderId` / Navidrome library id — omit for all libraries. */
  libraryScope?: string | null;
  artistLimit?: number;
  albumLimit?: number;
  songLimit?: number;
  /** UI generation — stale Rust FTS passes are dropped server-side. */
  requestEpoch?: number;
}

export function libraryLiveSearch(request: LibraryLiveSearchRequest): Promise<LibraryLiveSearchResponse> {
  const indexKey = serverIndexKeyForId(request.serverId);
  return invoke<LibraryLiveSearchResponse>('library_live_search', {
    request: { ...request, serverId: indexKey },
  }).then(response => ({
    ...response,
    artists: response.artists.map(artist => ({
      ...artist,
      serverId: mapServerIdFromIndexKey(artist.serverId, request.serverId),
    })),
    albums: response.albums.map(album => ({
      ...album,
      serverId: mapServerIdFromIndexKey(album.serverId, request.serverId),
    })),
    tracks: mapTracksServerId(response.tracks, request.serverId),
  }));
}

export interface LibraryLosslessAlbumsRequest {
  serverId: string;
  libraryScope?: string | null;
  limit?: number;
  offset?: number;
}

export interface LibraryLosslessAlbumsResponse {
  albums: LibraryAlbumDto[];
  hasMore: boolean;
  source: 'local';
}

/** Paginated lossless albums from the local track index. */
export function libraryListLosslessAlbums(
  request: LibraryLosslessAlbumsRequest,
): Promise<LibraryLosslessAlbumsResponse> {
  const indexKey = serverIndexKeyForId(request.serverId);
  return invoke<LibraryLosslessAlbumsResponse>('library_list_lossless_albums', {
    request: {
      serverId: indexKey,
      libraryScope: request.libraryScope ?? undefined,
      limit: request.limit,
      offset: request.offset,
    },
  }).then(response => ({
    ...response,
    albums: response.albums.map(album => ({
      ...album,
      serverId: mapServerIdFromIndexKey(album.serverId, request.serverId),
    })),
  }));
}

export interface LibraryArtistLosslessBrowseRequest {
  serverId: string;
  artistId: string;
  libraryScope?: string | null;
}

export interface LibraryArtistLosslessBrowseResponse {
  albums: LibraryAlbumDto[];
  tracks: LibraryTrackDto[];
  source: 'local';
}

/** Lossless albums + tracks for one artist from the local index. */
export function libraryGetArtistLosslessBrowse(
  request: LibraryArtistLosslessBrowseRequest,
): Promise<LibraryArtistLosslessBrowseResponse> {
  const indexKey = serverIndexKeyForId(request.serverId);
  return invoke<LibraryArtistLosslessBrowseResponse>('library_get_artist_lossless_browse', {
    request: {
      serverId: indexKey,
      artistId: request.artistId,
      libraryScope: request.libraryScope ?? undefined,
    },
  }).then(response => ({
    ...response,
    albums: response.albums.map(album => ({
      ...album,
      serverId: mapServerIdFromIndexKey(album.serverId, request.serverId),
    })),
    tracks: mapTracksServerId(response.tracks, request.serverId),
  }));
}

/** Cross-server FTS union over the given servers, or all `ready` ones (§5.5B). */
export function librarySearchCrossServer(args: {
  query: string;
  limit?: number;
  servers?: string[];
}): Promise<LibraryCrossServerSearchResponse> {
  const indexServers = args.servers?.map(serverIndexKeyForId);
  return invoke<LibraryCrossServerSearchResponse>('library_search_cross_server', {
    ...args,
    servers: indexServers,
  }).then(response => ({
    ...response,
    hits: mapTracksServerId(response.hits),
    fuzzy: mapTracksServerId(response.fuzzy),
    serversSearched: response.serversSearched.map(id => mapServerIdFromIndexKey(id)),
  }));
}

export function libraryGetTrack(
  serverId: string,
  trackId: string,
): Promise<LibraryTrackDto | null> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<LibraryTrackDto | null>('library_get_track', { serverId: indexKey, trackId })
    .then(track => (track ? { ...track, serverId } : track));
}

/** Seed library index rows from live Subsonic song payloads (pin/download cold miss). */
export function libraryUpsertSongsFromApi(
  serverId: string,
  songs: unknown[],
): Promise<number> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<number>('library_upsert_songs_from_api', { serverId: indexKey, songs });
}

/** `library_get_tracks_batch` cap (spec §7.1). */
export const LIBRARY_TRACKS_BATCH_LIMIT = 100;

export function libraryGetTracksBatch(refs: TrackRefDto[]): Promise<LibraryTrackDto[]> {
  const indexKeyMap = new Map<string, string>();
  const remapped = refs.map(ref => {
    const indexKey = serverIndexKeyForId(ref.serverId);
    if (!indexKeyMap.has(indexKey)) indexKeyMap.set(indexKey, ref.serverId);
    return { ...ref, serverId: indexKey };
  });
  return invoke<LibraryTrackDto[]>('library_get_tracks_batch', { refs: remapped })
    .then(tracks => tracks.map(track => ({
      ...track,
      serverId: mapServerIdFromIndexKey(track.serverId, indexKeyMap.get(track.serverId)),
    })));
}

/** Chunked batch fetch — safe when `refs.length` exceeds {@link LIBRARY_TRACKS_BATCH_LIMIT}. */
export async function libraryGetTracksBatchChunked(refs: TrackRefDto[]): Promise<LibraryTrackDto[]> {
  if (refs.length === 0) return [];
  const out: LibraryTrackDto[] = [];
  for (let i = 0; i < refs.length; i += LIBRARY_TRACKS_BATCH_LIMIT) {
    const chunk = refs.slice(i, i + LIBRARY_TRACKS_BATCH_LIMIT);
    const batch = await libraryGetTracksBatch(chunk).catch(() => []);
    out.push(...batch);
  }
  return out;
}

export function libraryGetTracksByAlbum(
  serverId: string,
  albumId: string,
): Promise<LibraryTrackDto[]> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<LibraryTrackDto[]>('library_get_tracks_by_album', { serverId: indexKey, albumId })
    .then(tracks => mapTracksServerId(tracks, serverId));
}

export function libraryGetArtifact(
  serverId: string,
  trackId: string,
  artifactKind: string,
  options?: { sourceKind?: string; sourceId?: string; format?: string },
): Promise<TrackArtifactDto | null> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<TrackArtifactDto | null>('library_get_artifact', {
    serverId: indexKey,
    trackId,
    artifactKind,
    sourceKind: options?.sourceKind,
    sourceId: options?.sourceId,
    format: options?.format,
  }).then(artifact => (artifact ? { ...artifact, serverId } : artifact));
}

export function libraryGetFacts(
  serverId: string,
  trackId: string,
  factKinds?: string[],
): Promise<TrackFactDto[]> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<TrackFactDto[]>('library_get_facts', { serverId: indexKey, trackId, factKinds })
    .then(facts => facts.map(fact => ({ ...fact, serverId })));
}

export function libraryGetOfflinePath(
  serverId: string,
  trackId: string,
): Promise<OfflinePathDto> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<OfflinePathDto>('library_get_offline_path', { serverId: indexKey, trackId })
    .then(path => ({ ...path, serverId }));
}

// ── Session + lifecycle (PR-5b) ───────────────────────────────────────

export function librarySyncBindSession(args: {
  serverId: string;
  baseUrl: string;
  username: string;
  password: string;
  libraryScope?: string;
}): Promise<void> {
  const indexKey = serverIndexKeyForId(args.serverId);
  return invoke<void>('library_sync_bind_session', { ...args, serverId: indexKey });
}

export function librarySyncClearSession(serverId: string): Promise<void> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<void>('library_sync_clear_session', { serverId: indexKey });
}

export type PlaybackHint = 'idle' | 'playing' | 'prefetch_active';

export function libraryGetPlaybackHint(): Promise<PlaybackHint> {
  return invoke<PlaybackHint>('library_get_playback_hint');
}

export function librarySetPlaybackHint(hint: PlaybackHint): Promise<void> {
  return invoke<void>('library_set_playback_hint', { hint });
}

export type SyncMode = 'full' | 'delta';

export function librarySyncStart(args: {
  serverId: string;
  mode: SyncMode;
  libraryScope?: string;
}): Promise<SyncJobDto> {
  const indexKey = serverIndexKeyForId(args.serverId);
  return invoke<SyncJobDto>('library_sync_start', { ...args, serverId: indexKey })
    .then(job => ({ ...job, serverId: args.serverId }));
}

/** Forced full-budget tombstone delta — Settings → «Verify integrity». */
export function librarySyncVerifyIntegrity(args: {
  serverId: string;
  libraryScope?: string;
}): Promise<SyncJobDto> {
  const indexKey = serverIndexKeyForId(args.serverId);
  return invoke<SyncJobDto>('library_sync_verify_integrity', { ...args, serverId: indexKey })
    .then(job => ({ ...job, serverId: args.serverId }));
}

export function librarySyncCancel(jobId?: string): Promise<void> {
  return invoke<void>('library_sync_cancel', { jobId });
}

export function libraryPatchTrack(args: {
  serverId: string;
  trackId: string;
  patch: {
    starredAt?: number | null;
    userRating?: number | null;
    playCount?: number | null;
    playedAt?: number | null;
    /** E2: playback-derived `md5_16kb` content fingerprint. Normally written
     *  by the Rust analysis bridge; exposed here for contract completeness. */
    contentHash?: string | null;
  };
}): Promise<void> {
  const indexKey = serverIndexKeyForId(args.serverId);
  return invoke<void>('library_patch_track', { ...args, serverId: indexKey });
}

/** Server favorites → `album.starred_at` (UPDATE only, no stub rows). */
export function libraryReconcileAlbumStars(args: {
  serverId: string;
  starredAlbums: Array<{ id: string; starredAt: number }>;
}): Promise<void> {
  const indexKey = serverIndexKeyForId(args.serverId);
  return invoke<void>('library_reconcile_album_stars', {
    serverId: indexKey,
    starredAlbums: args.starredAlbums.map(a => ({ id: a.id, starredAt: a.starredAt })),
  });
}

export function libraryPutArtifact(args: {
  serverId: string;
  trackId: string;
  artifact: ArtifactInputDto;
}): Promise<void> {
  const indexKey = serverIndexKeyForId(args.serverId);
  return invoke<void>('library_put_artifact', { ...args, serverId: indexKey });
}

export function libraryPutFact(args: {
  serverId: string;
  trackId: string;
  fact: FactInputDto;
}): Promise<void> {
  const indexKey = serverIndexKeyForId(args.serverId);
  return invoke<void>('library_put_fact', { ...args, serverId: indexKey });
}

export function libraryPurgeServer(args: {
  serverId: string;
  includeAnalysis?: boolean;
  includeOffline?: boolean;
}): Promise<PurgeReportDto> {
  const indexKey = serverIndexKeyForId(args.serverId);
  return invoke<PurgeReportDto>('library_purge_server', { ...args, serverId: indexKey });
}

export function libraryDeleteServerData(serverId: string): Promise<void> {
  const indexKey = serverIndexKeyForId(serverId);
  return invoke<void>('library_delete_server_data', { serverId: indexKey });
}

// ── Player stats (local listening history) ────────────────────────────

export type PlaySessionEndReason = 'ended' | 'skip' | 'stop' | 'switch' | 'close';

export type PlaySessionInput = {
  serverId: string;
  trackId: string;
  startedAtMs: number;
  listenedSec: number;
  positionMaxSec: number;
  endReason: PlaySessionEndReason;
  /** Player-known track duration when the library index has none. */
  durationSecHint?: number;
};

export type PlaySessionYearSummary = {
  totalListenedSec: number;
  sessionCount: number;
  trackPlayCount: number;
  uniqueTrackCount: number;
  listeningDayCount: number;
  fullCount: number;
  partialCount: number;
};

export type PlaySessionHeatmapDay = {
  date: string;
  trackPlayCount: number;
};

export type PlaySessionDayTrack = {
  serverId: string;
  trackId: string;
  title: string;
  artist: string | null;
  listenedSec: number;
  completion: 'partial' | 'full' | string;
  startedAtMs: number;
};

export type PlaySessionDayDetail = {
  totals: {
    totalListenedSec: number;
    sessionCount: number;
    trackPlayCount: number;
    fullCount: number;
    partialCount: number;
  };
  tracks: PlaySessionDayTrack[];
};

export type PlaySessionYearBounds = {
  minYear: number | null;
  maxYear: number | null;
};

export type CatalogYearBounds = {
  minYear: number | null;
  maxYear: number | null;
};

export type GenreAlbumCountRow = {
  value: string;
  albumCount: number;
  songCount: number;
};

export function libraryGetCatalogYearBounds(args: { serverId: string }): Promise<CatalogYearBounds> {
  const indexKey = serverIndexKeyForId(args.serverId);
  return invoke<CatalogYearBounds>('library_get_catalog_year_bounds', {
    serverId: indexKey,
  });
}

export function libraryGetGenreAlbumCounts(args: {
  serverId: string;
  libraryScope?: string;
}): Promise<GenreAlbumCountRow[]> {
  const indexKey = serverIndexKeyForId(args.serverId);
  return invoke<GenreAlbumCountRow[]>('library_get_genre_album_counts', {
    serverId: indexKey,
    libraryScope: args.libraryScope,
  });
}

export type LibraryGenreAlbumsRequest = {
  serverId: string;
  genre: string;
  libraryScope?: string | null;
  sort?: LibrarySortClause[];
  limit?: number;
  offset?: number;
  includeTotal?: boolean;
};

export type LibraryGenreAlbumsResponse = {
  albums: LibraryAlbumDto[];
  hasMore: boolean;
  total?: number | null;
  source: 'local';
};

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

export type PlaySessionRecentDay = {
  date: string;
  totalListenedSec: number;
  sessionCount: number;
  trackPlayCount: number;
  fullCount: number;
  partialCount: number;
};

export function libraryRecordPlaySession(input: PlaySessionInput): Promise<void> {
  const indexKey = serverIndexKeyForId(input.serverId);
  return invoke<void>('library_record_play_session', { input: { ...input, serverId: indexKey } });
}

export function libraryGetPlayerStatsYearSummary(year: number): Promise<PlaySessionYearSummary> {
  return invoke<PlaySessionYearSummary>('library_get_player_stats_year_summary', { year });
}

export function libraryGetPlayerStatsHeatmap(year: number): Promise<PlaySessionHeatmapDay[]> {
  return invoke<PlaySessionHeatmapDay[]>('library_get_player_stats_heatmap', { year });
}

export function libraryGetPlayerStatsDayDetail(dateIso: string): Promise<PlaySessionDayDetail> {
  return invoke<PlaySessionDayDetail>('library_get_player_stats_day_detail', { dateIso })
    .then(detail => ({
      ...detail,
      tracks: detail.tracks.map(track => ({
        ...track,
        serverId: mapServerIdFromIndexKey(track.serverId),
      })),
    }));
}

export function libraryGetPlayerStatsYearBounds(): Promise<PlaySessionYearBounds> {
  return invoke<PlaySessionYearBounds>('library_get_player_stats_year_bounds');
}

export function libraryGetPlayerStatsRecentDays(limit = 30): Promise<PlaySessionRecentDay[]> {
  return invoke<PlaySessionRecentDay[]>('library_get_player_stats_recent_days', { limit });
}

// ── Event subscriptions ───────────────────────────────────────────────

export interface LibrarySyncProgressPayload {
  serverId: string;
  libraryScope: string;
  /** 'phase_changed' | 'ingest_page' | 'remapped' | 'tombstoned' | 'completed' | 'error' */
  kind: string;
  phase?: string | null;
  ingestedTotal?: number | null;
  batchCount?: number | null;
  remappedCount?: number | null;
  tombstonesChecked?: number | null;
  tombstonesDeleted?: number | null;
  completedKind?: string | null;
  message?: string | null;
  /** S1 per-batch timings from the Rust ingest runner (when available). */
  ingestMetrics?: IngestBatchMetrics | null;
}

export interface IngestBatchMetrics {
  offset: number;
  strategy: string;
  fetchMs: number;
  writeMs: number;
  lockWaitMs: number;
  sqlExecMs: number;
  persistMs: number;
  rowCount: number;
  bulkIngestActive: boolean;
}

export interface LibrarySyncIdlePayload {
  serverId: string;
  libraryScope: string;
  kind: string; // 'initial_sync' | 'delta_sync'
  ok: boolean;
  error?: string | null;
}

export function subscribeLibrarySyncProgress(
  handler: (payload: LibrarySyncProgressPayload) => void,
): Promise<UnlistenFn> {
  return listen<LibrarySyncProgressPayload>('library:sync-progress', ({ payload }) =>
    handler(payload),
  );
}

export function subscribeLibrarySyncIdle(
  handler: (payload: LibrarySyncIdlePayload) => void,
): Promise<UnlistenFn> {
  return listen<LibrarySyncIdlePayload>('library:sync-idle', ({ payload }) =>
    handler(payload),
  );
}

// ── Genre tags startup backfill (multi-genre local index) ───────────────

export interface GenreTagsInspectDto {
  needed: boolean;
  totalTracks: number;
  doneTracks: number;
}

export interface GenreTagsProgressEvent {
  done: number;
  total: number;
}

export function libraryGenreTagsInspect(): Promise<GenreTagsInspectDto> {
  return invoke<GenreTagsInspectDto>('library_genre_tags_inspect');
}

export function libraryGenreTagsRun(): Promise<void> {
  return invoke<void>('library_genre_tags_run');
}
