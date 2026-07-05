import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { libraryGetRecentPlaySessions, type PlaySessionRecentTrack } from '@/lib/api/library';
import { seedQueueResolver, resolveBatch } from '@/features/playback/store/queueTrackResolver';
import {
  applyTimelineBootstrap,
  getTimelineSessionHistorySnapshot,
  isTimelineBootstrapAttempted,
  markTimelineBootstrapAttempted,
  subscribeTimelineSessionHistory,
  TIMELINE_HISTORY_BOOTSTRAP_LIMIT,
  type TimelinePlayedRef,
} from '@/features/playback/store/timelineSessionHistory';
import {
  bootstrapTrackFromPlaySession,
  timelineHistoryToQueueRefs,
} from '@/features/playback/utils/timelineHistoryRefs';
import { timelineBootstrapIndexReady } from '@/features/playback/utils/timelineBootstrapReady';

const BOOTSTRAP_RETRY_MS = 2_000;

let bootstrapInFlight = false;

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

/** Test-only: reset in-flight bootstrap guard. */
export function _resetTimelineBootstrapInFlightForTest(): void {
  bootstrapInFlight = false;
}

export async function ensureTimelineBootstrap(): Promise<void> {
  if (isTimelineBootstrapAttempted() || bootstrapInFlight) return;

  if (!(await timelineBootstrapIndexReady())) return;

  bootstrapInFlight = true;
  if (!markTimelineBootstrapAttempted()) {
    bootstrapInFlight = false;
    return;
  }

  try {
    const rows = await libraryGetRecentPlaySessions({ limit: TIMELINE_HISTORY_BOOTSTRAP_LIMIT });
    seedResolverFromBootstrap(rows);
    const oldestFirst = [...rows].reverse().map(bootstrapRowToRef);
    applyTimelineBootstrap(oldestFirst);
  } catch {
    /* bootstrapAttempted stays true — no retry until next app launch */
  } finally {
    bootstrapInFlight = false;
  }
}

export function useTimelinePlayHistory(): TimelinePlayedRef[] {
  return useSyncExternalStore(subscribeTimelineSessionHistory, getTimelineSessionHistorySnapshot);
}

export function useTimelineBootstrapOnMode(isTimeline: boolean): void {
  useEffect(() => {
    if (!isTimeline) return;

    let cancelled = false;

    const run = async () => {
      while (!cancelled && !isTimelineBootstrapAttempted()) {
        await ensureTimelineBootstrap();
        if (cancelled || isTimelineBootstrapAttempted()) break;
        await new Promise<void>(resolve => {
          window.setTimeout(resolve, BOOTSTRAP_RETRY_MS);
        });
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
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
