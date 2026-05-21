/**
 * Typed wrappers around the `library_*` Tauri commands (spec §7.1) plus
 * subscribers for `library:sync-progress` / `library:sync-idle` events
 * (§7.2). One thin file per cucadmuh's PR-5 kickoff Q1 — Settings UI
 * (LibraryTab) imports from here; nothing else in the app talks to the
 * backend library surface directly.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

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
  sort?: LibrarySortClause[];
  limit: number;
  offset?: number;
  /** Skip expensive COUNT queries (Live Search). */
  skipTotals?: boolean;
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

// ── Read commands (PR-5a) ─────────────────────────────────────────────

export function libraryGetStatus(
  serverId: string,
  libraryScope?: string,
): Promise<SyncStateDto> {
  return invoke<SyncStateDto>('library_get_status', { serverId, libraryScope });
}

export function librarySearch(
  serverId: string,
  query: string,
  options?: { limit?: number; offset?: number; libraryScope?: string },
): Promise<LibraryTracksEnvelope> {
  return invoke<LibraryTracksEnvelope>('library_search', {
    serverId,
    query,
    limit: options?.limit,
    offset: options?.offset,
    libraryScope: options?.libraryScope,
  });
}

/**
 * Advanced Search against the local index (§5.13). The frontend fallback
 * (PR-7 F2) decides local vs network and maps the same `LibraryFilterClause`
 * shape onto the network path; this wrapper only talks to the local builder.
 */
export function libraryAdvancedSearch(
  request: LibraryAdvancedSearchRequest,
): Promise<LibraryAdvancedSearchResponse> {
  return invoke<LibraryAdvancedSearchResponse>('library_advanced_search', { request });
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
  return invoke<LibraryLiveSearchResponse>('library_live_search', { request });
}

/** Cross-server FTS union over the given servers, or all `ready` ones (§5.5B). */
export function librarySearchCrossServer(args: {
  query: string;
  limit?: number;
  servers?: string[];
}): Promise<LibraryCrossServerSearchResponse> {
  return invoke<LibraryCrossServerSearchResponse>('library_search_cross_server', args);
}

export function libraryGetTrack(
  serverId: string,
  trackId: string,
): Promise<LibraryTrackDto | null> {
  return invoke<LibraryTrackDto | null>('library_get_track', { serverId, trackId });
}

export function libraryGetTracksBatch(refs: TrackRefDto[]): Promise<LibraryTrackDto[]> {
  return invoke<LibraryTrackDto[]>('library_get_tracks_batch', { refs });
}

export function libraryGetTracksByAlbum(
  serverId: string,
  albumId: string,
): Promise<LibraryTrackDto[]> {
  return invoke<LibraryTrackDto[]>('library_get_tracks_by_album', { serverId, albumId });
}

export function libraryGetArtifact(
  serverId: string,
  trackId: string,
  artifactKind: string,
  options?: { sourceKind?: string; sourceId?: string; format?: string },
): Promise<TrackArtifactDto | null> {
  return invoke<TrackArtifactDto | null>('library_get_artifact', {
    serverId,
    trackId,
    artifactKind,
    sourceKind: options?.sourceKind,
    sourceId: options?.sourceId,
    format: options?.format,
  });
}

export function libraryGetFacts(
  serverId: string,
  trackId: string,
  factKinds?: string[],
): Promise<TrackFactDto[]> {
  return invoke<TrackFactDto[]>('library_get_facts', { serverId, trackId, factKinds });
}

export function libraryGetOfflinePath(
  serverId: string,
  trackId: string,
): Promise<OfflinePathDto> {
  return invoke<OfflinePathDto>('library_get_offline_path', { serverId, trackId });
}

// ── Session + lifecycle (PR-5b) ───────────────────────────────────────

export function librarySyncBindSession(args: {
  serverId: string;
  baseUrl: string;
  username: string;
  password: string;
  libraryScope?: string;
}): Promise<void> {
  return invoke<void>('library_sync_bind_session', args);
}

export function librarySyncClearSession(serverId: string): Promise<void> {
  return invoke<void>('library_sync_clear_session', { serverId });
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
  return invoke<SyncJobDto>('library_sync_start', args);
}

/** Forced full-budget tombstone delta — Settings → «Verify integrity». */
export function librarySyncVerifyIntegrity(args: {
  serverId: string;
  libraryScope?: string;
}): Promise<SyncJobDto> {
  return invoke<SyncJobDto>('library_sync_verify_integrity', args);
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
  return invoke<void>('library_patch_track', args);
}

export function libraryPutArtifact(args: {
  serverId: string;
  trackId: string;
  artifact: ArtifactInputDto;
}): Promise<void> {
  return invoke<void>('library_put_artifact', args);
}

export function libraryPutFact(args: {
  serverId: string;
  trackId: string;
  fact: FactInputDto;
}): Promise<void> {
  return invoke<void>('library_put_fact', args);
}

export function libraryPurgeServer(args: {
  serverId: string;
  includeAnalysis?: boolean;
  includeOffline?: boolean;
}): Promise<PurgeReportDto> {
  return invoke<PurgeReportDto>('library_purge_server', args);
}

export function libraryDeleteServerData(serverId: string): Promise<void> {
  return invoke<void>('library_delete_server_data', { serverId });
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
