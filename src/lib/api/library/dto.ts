/**
 * DTO mirrors for the `library_*` Tauri command surface (camelCase, matching the
 * Rust `#[serde(rename_all = "camelCase")]`). Split out of the former single
 * `lib/api/library.ts` god-module; the wrappers (reads/sync/stats/events) and the
 * `@/lib/api/library` barrel re-export these, so consumers are unchanged.
 */
import type {
  CatalogYearBoundsDto,
  GenreAlbumCountDto,
  LibraryEntitySourceDto as GeneratedLibraryEntitySourceDto,
  LibraryResolveEntitySourcesRequest as GeneratedLibraryResolveEntitySourcesRequest,
  LibrarySourceEntityType as GeneratedLibrarySourceEntityType,
} from '@/generated/bindings';

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
  replayGainPeak?: number | null;
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

/** Album-artist vs track-performer browse when querying artists (#1209). */
export type ArtistCreditMode = 'album' | 'track';

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

/** One server + library source — `null` means the whole server; `''` stays exact. */
export interface LibraryScopePair {
  serverId: string;
  libraryId: string | null;
}

export interface LibraryScopeCatalogStatisticsRequest {
  scopes: LibraryScopePair[];
  formatSampleLimit?: number;
}

export interface LibraryScopeCatalogStatisticsDto {
  artistCount: number;
  albumCount: number;
  trackCount: number;
  durationSec: number;
  genres: GenreAlbumCountRow[];
  formats: Array<{ format: string; count: number }>;
  formatSampleSize: number;
}

export interface LibraryScopeMostPlayedAlbumDto {
  album: LibraryAlbumDto;
  playCount: number;
}

export type LibrarySourceEntityType = GeneratedLibrarySourceEntityType;
export type LibraryResolveEntitySourcesRequest = GeneratedLibraryResolveEntitySourcesRequest;
export type LibraryEntitySourceDto = GeneratedLibraryEntitySourceDto;

export interface LibraryAdvancedSearchRequest {
  serverId: string;
  libraryScope?: string | null;
  libraryScopes?: LibraryScopePair[];
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
  /** Artist browse credit semantics (#1209). Omitted/null → album artists. */
  artistCreditMode?: ArtistCreditMode | null;
  /** A–Z, `#`, `OTHER`, or omit/`ALL` — letter bucket on local artist browse. */
  artistLetterBucket?: string | null;
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
  libraryScopes?: LibraryScopePair[];
  artistLimit?: number;
  albumLimit?: number;
  songLimit?: number;
  /** UI generation — stale Rust FTS passes are dropped server-side. */
  requestEpoch?: number;
}

export interface LibraryLosslessAlbumsRequest {
  serverId: string;
  libraryScope?: string | null;
  /** Ordered server/library sources; wins over `libraryScope`. */
  libraryScopes?: LibraryScopePair[] | null;
  limit?: number;
  offset?: number;
}

export interface LibraryLosslessAlbumsResponse {
  albums: LibraryAlbumDto[];
  hasMore: boolean;
  source: 'local';
}

export interface LibraryArtistLosslessBrowseRequest {
  serverId: string;
  artistId: string;
  libraryScope?: string | null;
  /** Ordered server/library sources; wins over `libraryScope`. */
  libraryScopes?: LibraryScopePair[] | null;
}

export interface LibraryArtistLosslessBrowseResponse {
  albums: LibraryAlbumDto[];
  tracks: LibraryTrackDto[];
  source: 'local';
}

export type PlaybackHint = 'idle' | 'playing' | 'prefetch_active';

export type SyncMode = 'full' | 'delta';

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
  completion: 'partial' | 'full';
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

// Sourced from the tauri-specta contract (single source of truth); kept as named
// aliases so existing consumers stay unchanged while the shape lives in one place.
export type CatalogYearBounds = CatalogYearBoundsDto;
export type GenreAlbumCountRow = GenreAlbumCountDto;

export type LibraryGenreAlbumsRequest = {
  serverId: string;
  genre: string;
  libraryScope?: string | null;
  libraryScopes?: LibraryScopePair[];
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

export type PlaySessionRecentDay = {
  date: string;
  totalListenedSec: number;
  sessionCount: number;
  trackPlayCount: number;
  fullCount: number;
  partialCount: number;
};

export type PlaySessionRecentTrack = {
  serverId: string;
  trackId: string;
  title: string;
  artist: string | null;
  album: string | null;
  albumId: string | null;
  coverArtId: string | null;
  startedAtMs: number;
  listenedSec: number;
  completion: 'partial' | 'full';
};

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
