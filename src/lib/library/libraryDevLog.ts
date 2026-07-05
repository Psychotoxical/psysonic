/** DevTools diagnostics for local library index + search (DEV only).
 * Filter console: `[psysonic][library]`
 * Search one-liner: `search [surface] path=… winner=…` or `source=…`
 * Ring buffer: `window.__PSYSONIC_LIBRARY_DEBUG__`
 */
import type { SyncStateDto } from '@/lib/api/library';
import { syncIngestDisplayCount } from './libraryReady';

const PREFIX = '[psysonic][library]';
const MAX_RING = 40;

export type LibrarySearchPath =
  | 'library_live_search'
  | 'library_advanced_search'
  | 'search3'
  | 'search_race'
  | 'browse_race'
  | 'browse_local_fallback'
  | 'browse_network_fallback'
  | 'browse_race_miss'
  | 'skipped_not_ready'
  | 'local_empty_fallback';

/** UI surface for unified search DevTools lines (`search [surface] …`). */
export type LibrarySearchSurface =
  | 'live_search'
  | 'advanced_search'
  | 'artists_browse'
  | 'albums_browse'
  | 'composers_browse'
  | 'tracks_browse'
  | 'search_results';

export interface LibrarySearchDebugEntry {
  at: string;
  query: string;
  path: LibrarySearchPath;
  durationMs: number;
  debounceMs?: number;
  indexEnabled?: boolean;
  localReadyCached?: boolean;
  ready?: boolean;
  readyReason?: string;
  readyCheckMs?: number;
  invokeMs?: number;
  counts?: { artists: number; albums: number; songs: number };
  fallbackReason?: string;
  error?: string;
  /** Winner when local + network ran in parallel. */
  raceWinner?: 'local' | 'network';
  raceWinnerMs?: number;
  /** Direct (non-race) path source. */
  source?: 'local' | 'network';
  surface?: LibrarySearchSurface;
}

export interface LibrarySyncDebugEntry {
  at: string;
  kind: string;
  serverId: string;
  libraryScope?: string;
  ingestStrategy?: string | null;
  ingestPhase?: string | null;
  syncPhase?: string;
  n1BulkUnreliable?: boolean | null;
  ingestedTotal?: number | null;
  batchCount?: number | null;
  localTrackCount?: number | null;
  serverTrackCount?: number | null;
  message?: string | null;
  durationMs?: number;
  /** ms since the previous ingest_page event (UI stall detector). */
  sinceLastIngestMs?: number;
  ingestMetrics?: IngestBatchMetrics | null;
  stallHint?: string;
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

/** Accept camelCase (wire) or legacy snake_case ingest metrics. */
export function normalizeIngestMetrics(raw: unknown): IngestBatchMetrics | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const num = (camel: string, snake: string) =>
    Number(m[camel] ?? m[snake] ?? 0);
  return {
    offset: num('offset', 'offset'),
    strategy: String(m.strategy ?? ''),
    fetchMs: num('fetchMs', 'fetch_ms'),
    writeMs: num('writeMs', 'write_ms'),
    lockWaitMs: num('lockWaitMs', 'lock_wait_ms'),
    sqlExecMs: num('sqlExecMs', 'sql_exec_ms'),
    persistMs: num('persistMs', 'persist_ms'),
    rowCount: num('rowCount', 'row_count'),
    bulkIngestActive: Boolean(m.bulkIngestActive ?? m.bulk_ingest_active ?? false),
  };
}

type LibraryDebugRing = {
  search: LibrarySearchDebugEntry[];
  sync: LibrarySyncDebugEntry[];
};

declare global {
  interface Window {
    __PSYSONIC_LIBRARY_DEBUG__?: LibraryDebugRing;
  }
}

function ring(): LibraryDebugRing {
  if (typeof window === 'undefined') {
    return { search: [], sync: [] };
  }
  if (!window.__PSYSONIC_LIBRARY_DEBUG__) {
    window.__PSYSONIC_LIBRARY_DEBUG__ = { search: [], sync: [] };
  }
  return window.__PSYSONIC_LIBRARY_DEBUG__;
}

function pushRing<T>(key: 'search' | 'sync', entry: T): void {
  if (!import.meta.env.DEV) return;
  const buf = ring()[key] as T[];
  buf.push(entry);
  if (buf.length > MAX_RING) buf.splice(0, buf.length - MAX_RING);
}

export function libraryDevEnabled(): boolean {
  return import.meta.env.DEV;
}

const LARGE_LIBRARY_THRESHOLD = 40_000;

/** Label for cursor strategy tag (`n1` / `s1` / `s2`). */
export function formatIngestStrategyLabel(tag: string | null | undefined): string {
  switch (tag) {
    case 'n1':
      return 'N1 — Navidrome GET /api/song (bulk)';
    case 's1':
      return 'S1 — Subsonic search3 empty query';
    case 's2':
      return 'S2 — getAlbumList2 + getAlbum per album';
    default:
      return tag ?? '(cursor not written yet)';
  }
}

/** Best-effort when cursor.strategy is still empty (before first persist). */
export function inferInitialIngestStrategy(status: SyncStateDto): string {
  const flags = status.capabilityFlags ?? 0;
  const n1 = (flags & 0x001) !== 0;
  const s1 = (flags & 0x002) !== 0;
  const server = status.serverTrackCount ?? 0;
  const large = server > LARGE_LIBRARY_THRESHOLD;
  const unreliable = status.n1BulkUnreliable === true;
  if (!unreliable && !large && n1) return 'n1';
  if (s1) return 's1';
  return 's2';
}

export function activeIngestStrategy(status: SyncStateDto): {
  tag: string;
  label: string;
  fromCursor: boolean;
} {
  const tag = status.ingestStrategy ?? inferInitialIngestStrategy(status);
  return {
    tag,
    label: formatIngestStrategyLabel(tag),
    fromCursor: status.ingestStrategy != null,
  };
}

export function ingestParallelismNote(
  strategy: string,
  playbackHint: 'idle' | 'playing' | 'prefetch_active',
): string {
  const depth =
    playbackHint === 'idle' ? 4 : playbackHint === 'playing' ? 1 : 0;
  if (playbackHint === 'prefetch_active') {
    return 'bulk crawl paused (waveform/queue prefetch active)';
  }
  if (playbackHint === 'playing') {
    return `${strategy.toUpperCase()}: sequential HTTP (playback active, max 1)`;
  }
  if (strategy === 's2') {
    return 'S2: parallel getAlbum up to 4 per album-list page';
  }
  return `${strategy.toUpperCase()}: prefetch up to ${depth} HTTP pages; IS-3 writes upsert-only (remap/canonical deferred)`;
}

export function decodeCapabilityFlags(flags: number): string[] {
  const out: string[] = [];
  if (flags & 0x001) out.push('navidromeNativeBulk(N1)');
  if (flags & 0x002) out.push('subsonicSearch3Bulk(S1)');
  if (flags & 0x004) out.push('scanStatus');
  if (flags & 0x008) out.push('openSubsonic');
  if (flags & 0x010) out.push('unstableTrackIds');
  if (flags & 0x020) out.push('fileTreeBrowse');
  if (out.length === 0) out.push('none');
  return out;
}

/** Human-readable reason for `libraryStatusIsReady` (DevTools). */
export function explainLibraryReady(status: SyncStateDto): string {
  if (status.syncPhase === 'ready') return 'syncPhase=ready';
  if (status.syncPhase === 'initial_sync') {
    const local = syncIngestDisplayCount(status);
    const server = status.serverTrackCount ?? 0;
    if (server > 0 && local / server >= 0.95) {
      return `initial_sync coverage ${local}/${server} (≥95%)`;
    }
    return `initial_sync coverage ${local}/${server} (<95%)`;
  }
  if (status.syncPhase === 'idle') {
    if (status.hasLocalTracks) return 'idle + hasLocalTracks';
    if (status.lastFullSyncAt != null) return 'idle + lastFullSyncAt';
    if ((status.localTracksMaxUpdatedMs ?? 0) > 0) return 'idle + localTracksMaxUpdatedMs';
    if ((status.localTrackCount ?? 0) > 0) return 'idle + localTrackCount';
    return 'idle, no ready signals';
  }
  if (status.syncPhase === 'probing') return 'syncPhase=probing';
  return `syncPhase=${status.syncPhase}`;
}

export function formatLibrarySearchLine(entry: LibrarySearchDebugEntry): string {
  const surface = entry.surface ?? '?';
  const hits = entry.counts
    ? ` hits=${entry.counts.artists}/${entry.counts.albums}/${entry.counts.songs}`
    : '';
  const fallback = entry.fallbackReason ? ` fallback=${entry.fallbackReason}` : '';
  const invoke = entry.invokeMs != null ? ` invokeMs=${entry.invokeMs}` : '';
  const debounce = entry.debounceMs != null ? ` debounceMs=${entry.debounceMs}` : '';
  const error = entry.error ? ` error=${entry.error}` : '';

  if (entry.raceWinner) {
    return (
      `search [${surface}] path=${entry.path} winner=${entry.raceWinner}` +
      ` raceMs=${entry.raceWinnerMs ?? 0} totalMs=${entry.durationMs}` +
      `${invoke}${debounce}${hits}${fallback}${error}`
    );
  }
  if (entry.source) {
    return (
      `search [${surface}] path=${entry.path} source=${entry.source}` +
      ` totalMs=${entry.durationMs}${invoke}${debounce}${hits}${fallback}${error}`
    );
  }
  return (
    `search [${surface}] path=${entry.path} totalMs=${entry.durationMs}` +
    `${invoke}${debounce}${hits}${fallback}${error}`
  );
}

export function logLibrarySearch(entry: LibrarySearchDebugEntry): void {
  if (!libraryDevEnabled()) return;
  pushRing('search', entry);
  console.debug(PREFIX, formatLibrarySearchLine(entry), entry);
}

export function logLibrarySync(entry: LibrarySyncDebugEntry): void {
  if (!libraryDevEnabled()) return;
  pushRing('sync', entry);
  const m = entry.ingestMetrics;
  const slow =
    (m?.lockWaitMs ?? 0) >= 1000 ||
    (m?.writeMs ?? 0) >= 1000 ||
    (m?.fetchMs ?? 0) >= 5000 ||
    (entry.sinceLastIngestMs ?? 0) >= 5000;
  if (entry.kind === 'ingest_page' && m) {
    const line = `[ingest] off=${m.offset} fetch=${m.fetchMs}ms write=${m.writeMs}ms lockWait=${m.lockWaitMs}ms sql=${m.sqlExecMs}ms persist=${m.persistMs}ms rows=${m.rowCount} bulk=${m.bulkIngestActive}${entry.sinceLastIngestMs != null ? ` gap=${entry.sinceLastIngestMs}ms` : ''}${entry.stallHint ? ` hint=${entry.stallHint}` : ''}`;
    if (slow) {
      console.warn(PREFIX, 'ingest-batch SLOW', line, entry);
    } else {
      console.debug(PREFIX, 'ingest-batch', line, entry);
    }
    return;
  }
  console.debug(PREFIX, 'sync', entry);
}

/** Derive a short hint when batch timings implicate a specific bottleneck. */
export function ingestStallHint(metrics: IngestBatchMetrics): string | undefined {
  if (metrics.lockWaitMs >= 1000 && metrics.sqlExecMs < 200) {
    return 'write_lock_held_by_other_op';
  }
  if (metrics.fetchMs >= 5000 && metrics.lockWaitMs < 500) {
    return 'slow_subsonic_fetch';
  }
  if (metrics.sqlExecMs >= 1000 && metrics.lockWaitMs < 500) {
    return 'slow_sqlite_upsert';
  }
  if (metrics.persistMs >= 500) {
    return 'slow_cursor_persist';
  }
  return undefined;
}

export function logLibraryStatus(
  serverId: string,
  status: SyncStateDto,
  label: string,
  playbackHint: 'idle' | 'playing' | 'prefetch_active' = 'idle',
): void {
  if (!libraryDevEnabled()) return;
  const ingest = activeIngestStrategy(status);
  console.debug(PREFIX, 'status', label, {
    serverId,
    syncPhase: status.syncPhase,
    ready: explainLibraryReady(status),
    ingestStrategy: ingest.tag,
    ingestStrategyLabel: ingest.label,
    ingestFromCursor: ingest.fromCursor,
    ingestPhase: status.ingestPhase ?? null,
    cursorIngestedCount: status.cursorIngestedCount ?? null,
    playbackHint,
    ingestPrefetchDepth: playbackHint === 'idle' ? 4 : playbackHint === 'playing' ? 1 : 0,
    parallelismNote: ingestParallelismNote(ingest.tag, playbackHint),
    n1BulkUnreliable: status.n1BulkUnreliable ?? null,
    localTrackCount: status.localTrackCount ?? null,
    serverTrackCount: status.serverTrackCount ?? null,
    hasLocalTracks: status.hasLocalTracks ?? false,
    capabilities: decodeCapabilityFlags(status.capabilityFlags ?? 0),
  });
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = performance.now();
  const result = await fn();
  return { result, ms: Math.round(performance.now() - t0) };
}
