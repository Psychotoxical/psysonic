import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { libraryGetRecentPlaySessions, type PlaySessionRecentTrack } from '../api/library';
import { seedQueueResolver, resolveBatch } from '../utils/library/queueTrackResolver';
import {
  applyTimelineBootstrap,
  getTimelineSessionHistorySnapshot,
  markTimelineBootstrapAttempted,
  subscribeTimelineSessionHistory,
  TIMELINE_HISTORY_BOOTSTRAP_LIMIT,
  type TimelinePlayedRef,
} from '../store/timelineSessionHistory';
import {
  bootstrapTrackFromPlaySession,
  timelineHistoryToQueueRefs,
} from '../utils/queue/timelineHistoryRefs';

function bootstrapRowToRef(row: PlaySessionRecentTrack): TimelinePlayedRef {
  return {
    serverId: row.serverId,
    trackId: row.trackId,
    playedAtMs: row.startedAtMs,
  };
}

function seedResolverFromBootstrap(rows: PlaySessionRecentTrack[]): void {
  const byServer = new Map<string, ReturnType<typeof bootstrapTrackFromPlaySession>[]>();
  for (const row of rows) {
    const track = bootstrapTrackFromPlaySession(row);
    const arr = byServer.get(row.serverId) ?? [];
    arr.push(track);
    byServer.set(row.serverId, arr);
  }
  for (const [serverId, tracks] of byServer) {
    seedQueueResolver(serverId, tracks);
  }
}

export function ensureTimelineBootstrap(): void {
  if (!markTimelineBootstrapAttempted()) return;

  void libraryGetRecentPlaySessions({ limit: TIMELINE_HISTORY_BOOTSTRAP_LIMIT })
    .then(rows => {
      seedResolverFromBootstrap(rows);
      const oldestFirst = [...rows].reverse().map(bootstrapRowToRef);
      applyTimelineBootstrap(oldestFirst);
    })
    .catch(() => {
      /* bootstrapAttempted stays true — no retry until next app launch */
    });
}

export function useTimelinePlayHistory(): TimelinePlayedRef[] {
  return useSyncExternalStore(subscribeTimelineSessionHistory, getTimelineSessionHistorySnapshot);
}

export function useTimelineBootstrapOnMode(isTimeline: boolean): void {
  useEffect(() => {
    if (!isTimeline) return;
    ensureTimelineBootstrap();
  }, [isTimeline]);
}

/** Prefetch full track metadata (incl. cover ids) for cross-server history rows. */
export function useTimelineHistoryResolver(
  historyRefs: TimelinePlayedRef[],
  enabled: boolean,
): void {
  const refsKey = useMemo(
    () => historyRefs.map(r => `${r.serverId}:${r.trackId}:${r.playedAtMs}`).join('\u0001'),
    [historyRefs],
  );
  useEffect(() => {
    if (!enabled || historyRefs.length === 0) return;
    void resolveBatch(timelineHistoryToQueueRefs(historyRefs));
  }, [enabled, refsKey, historyRefs]);
}
