import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import {
  getPlaybackServerId,
  playbackProfileIdForTrack,
} from '@/features/playback/utils/playback/playbackServer';
import { usePreviewStore } from '@/features/playback/store/previewStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';

export const TIMELINE_HISTORY_BOOTSTRAP_LIMIT = 50;
export const TIMELINE_APPEND_DEDUPE_MS = 2_000;
export const TIMELINE_MERGE_DEDUPE_MS = 5_000;

export type TimelinePlayedRef = {
  serverId: string;
  trackId: string;
  playedAtMs: number;
};

let sessionPlays: TimelinePlayedRef[] = [];
let historyClearedThisSession = false;
let bootstrapAttempted = false;
/** Stable reference for `useSyncExternalStore` until the next `emit`. */
let sessionPlaysSnapshot: TimelinePlayedRef[] = sessionPlays;

const listeners = new Set<() => void>();

function emit(): void {
  sessionPlaysSnapshot = sessionPlays;
  for (const cb of listeners) cb();
}

export function subscribeTimelineSessionHistory(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getTimelineSessionHistorySnapshot(): TimelinePlayedRef[] {
  return sessionPlaysSnapshot;
}

export function isTimelineHistoryClearedThisSession(): boolean {
  return historyClearedThisSession;
}

export function isTimelineBootstrapAttempted(): boolean {
  return bootstrapAttempted;
}

/** Returns false if bootstrap was already started this session. */
export function markTimelineBootstrapAttempted(): boolean {
  if (bootstrapAttempted) return false;
  bootstrapAttempted = true;
  return true;
}

function isDuplicateInBuffer(
  buffer: TimelinePlayedRef[],
  candidate: TimelinePlayedRef,
  windowMs: number,
): boolean {
  return buffer.some(
    row =>
      row.serverId === candidate.serverId
      && row.trackId === candidate.trackId
      && Math.abs(row.playedAtMs - candidate.playedAtMs) <= windowMs,
  );
}

export function appendTimelineSessionPlay(ref: TimelinePlayedRef): void {
  if (!ref.serverId || !ref.trackId) return;
  const last = sessionPlays[sessionPlays.length - 1];
  if (
    last
    && last.serverId === ref.serverId
    && last.trackId === ref.trackId
    && Math.abs(ref.playedAtMs - last.playedAtMs) <= TIMELINE_APPEND_DEDUPE_MS
  ) {
    return;
  }
  sessionPlays = [...sessionPlays, ref];
  emit();
}

export function appendTimelineLeaveTrack(
  prevTrack: Track | null,
  queueItems: QueueItemRef[],
  queueIndex: number,
): void {
  if (!prevTrack) return;
  if (usePlayerStore.getState().currentRadio) return;
  if (usePreviewStore.getState().previewingId) return;
  const prevRef = queueIndex >= 0 && queueIndex < queueItems.length
    ? queueItems[queueIndex]
    : undefined;
  const serverId =
    playbackProfileIdForTrack(prevTrack, prevRef)
    ?? getPlaybackServerId()
    ?? prevRef?.serverId
    ?? prevTrack.serverId
    ?? '';
  appendTimelineSessionPlay({
    serverId,
    trackId: prevTrack.id,
    playedAtMs: Date.now(),
  });
}

export function clearTimelineSessionHistory(): void {
  historyClearedThisSession = true;
  sessionPlays = [];
  emit();
}

export function applyTimelineBootstrap(rowsOldestFirst: TimelinePlayedRef[]): void {
  if (historyClearedThisSession || rowsOldestFirst.length === 0) return;

  if (sessionPlays.length === 0) {
    sessionPlays = [...rowsOldestFirst];
    emit();
    return;
  }

  const firstLiveMs = sessionPlays[0]!.playedAtMs;
  const toPrepend = rowsOldestFirst.filter(row => row.playedAtMs < firstLiveMs);
  const deduped = toPrepend.filter(
    row => !isDuplicateInBuffer(sessionPlays, row, TIMELINE_MERGE_DEDUPE_MS),
  );
  if (deduped.length === 0) return;
  sessionPlays = [...deduped, ...sessionPlays];
  emit();
}

/** Test-only reset */
export function _resetTimelineSessionHistoryForTest(): void {
  sessionPlays = [];
  sessionPlaysSnapshot = sessionPlays;
  historyClearedThisSession = false;
  bootstrapAttempted = false;
  listeners.clear();
}
