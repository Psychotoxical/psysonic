import { coverEnsureQueueBacklog } from '@/cover/ensureQueue';

/** Target in-flight + queued ensures ≈ workers × multiplier (mirror analysis backfill). */
export const LIBRARY_COVER_BACKLOG_DEPTH_MULTIPLIER = 3;
export const LIBRARY_COVER_BACKLOG_MIN = 8;
export const LIBRARY_COVER_BACKLOG_MAX = 48;

export function computeLibraryCoverBackfillTargetDepth(workers: number): number {
  const w = Math.max(1, Math.round(workers));
  return Math.min(
    LIBRARY_COVER_BACKLOG_MAX,
    Math.max(LIBRARY_COVER_BACKLOG_MIN, w * LIBRARY_COVER_BACKLOG_DEPTH_MULTIPLIER),
  );
}

export function libraryCoverBackfillNeedsTopUp(workers: number): boolean {
  return coverEnsureQueueBacklog() < computeLibraryCoverBackfillTargetDepth(workers);
}

export function libraryCoverBackfillTopUpLimit(workers: number, maxBatch: number): number {
  const target = computeLibraryCoverBackfillTargetDepth(workers);
  const deficit = target - coverEnsureQueueBacklog();
  if (deficit <= 0) return 0;
  return Math.min(maxBatch, deficit);
}
