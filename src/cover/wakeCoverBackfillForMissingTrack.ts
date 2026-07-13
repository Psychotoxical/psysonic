import { wakeLibraryCoverBackfill } from '@/lib/library/coverBackfillWake';
import { coverStrategyAllowsLibraryBackfill } from '@/lib/library/coverStrategy';
import { resolveAlbumCoverEntry } from '@/cover/resolveEntry';
import { useAuthStore } from '@/store/authStore';
import { useCoverStrategyStore } from '@/store/coverStrategyStore';

let lastWakeMs = 0;
const WAKE_COOLDOWN_MS = 4_000;

/**
 * When a visible track row lacks index metadata needed for a cover ref, nudge
 * the native library cover backfill (aggressive strategy only). Throttled so
 * virtualized lists do not spam wakes.
 */
export function wakeCoverBackfillForMissingTrack(
  song: { albumId?: string | null; coverArt?: string | null; serverId?: string | null },
): void {
  const albumId = song.albumId?.trim();
  if (albumId && resolveAlbumCoverEntry(albumId, song.coverArt)?.fetchCoverArtId) return;

  const now = Date.now();
  if (lastWakeMs > 0 && now - lastWakeMs < WAKE_COOLDOWN_MS) return;

  const serverId = song.serverId?.trim() || useAuthStore.getState().activeServerId;
  if (!serverId) return;
  const strategy = useCoverStrategyStore.getState().getStrategyForServer(serverId);
  if (!coverStrategyAllowsLibraryBackfill(strategy)) return;

  lastWakeMs = now;
  wakeLibraryCoverBackfill();
}
