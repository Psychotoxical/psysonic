/**
 * Is the local library index usable for `serverId` right now?
 *
 * Spec §5.13.6 / §9.3 (`isReady()`): consumers only read from the local
 * index when it's enabled and synced enough for trustworthy results.
 */
import { libraryGetStatus, type SyncStateDto } from '@/lib/api/library';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';

/** Spec §9.3 — shared by Live Search, Advanced Search, browse, … */
export function libraryStatusIsReady(status: SyncStateDto): boolean {
  if (status.syncPhase === 'ready') return true;
  if (status.syncPhase === 'initial_sync') {
    const local = status.localTrackCount ?? 0;
    const server = status.serverTrackCount ?? 0;
    if (server > 0 && local / server >= 0.95) return true;
  }
  // Re-bind resets sync_phase to `idle` while SQLite data stays — treat a
  // completed full sync (or live rows) as ready for local reads.
  if (status.syncPhase === 'idle') {
    if (status.hasLocalTracks) return true;
    if (status.lastFullSyncAt != null) return true;
    if ((status.localTracksMaxUpdatedMs ?? 0) > 0) return true;
    if ((status.localTrackCount ?? 0) > 0) return true;
  }
  return false;
}

/** Track count for Settings status when the index is usable. */
export function libraryStatusDisplayTrackCount(
  status: Pick<SyncStateDto, 'localTrackCount' | 'cursorIngestedCount'>,
): number {
  return syncIngestDisplayCount(status);
}

/** Monotonic ingest counter for Settings progress during `initial_sync`. */
export function syncIngestDisplayCount(
  status: Pick<SyncStateDto, 'localTrackCount' | 'cursorIngestedCount'>,
  eventTotal?: number | null,
): number {
  return Math.max(
    status.localTrackCount ?? 0,
    status.cursorIngestedCount ?? 0,
    eventTotal ?? 0,
    0,
  );
}

/** True while library sync holds SQLite — pause cover backfill / heavy cover RPC. */
export function librarySyncBlocksCoverWork(
  status: Pick<SyncStateDto, 'syncPhase'>,
): boolean {
  return status.syncPhase === 'initial_sync' || status.syncPhase === 'probing';
}

export async function libraryIsReady(serverId: string | null | undefined): Promise<boolean> {
  if (!serverId) return false;
  if (!useLibraryIndexStore.getState().isIndexEnabled(serverId)) return false;
  try {
    const status = await libraryGetStatus(serverId);
    return libraryStatusIsReady(status);
  } catch {
    return false;
  }
}
