import { useEffect, useSyncExternalStore } from 'react';
import { libraryGetRecentPlaySessions, type PlaySessionRecentTrack } from '../api/library';
import { seedQueueResolver } from '../utils/library/queueTrackResolver';
import {
  applyTimelineBootstrap,
  getTimelineSessionHistorySnapshot,
  markTimelineBootstrapAttempted,
  subscribeTimelineSessionHistory,
  TIMELINE_HISTORY_BOOTSTRAP_LIMIT,
  type TimelinePlayedRef,
} from '../store/timelineSessionHistory';

function bootstrapRowToRef(row: PlaySessionRecentTrack): TimelinePlayedRef {
  return {
    serverId: row.serverId,
    trackId: row.trackId,
    playedAtMs: row.startedAtMs,
  };
}

function seedResolverFromBootstrap(rows: PlaySessionRecentTrack[]): void {
  for (const row of rows) {
    seedQueueResolver(row.serverId, [{
      id: row.trackId,
      title: row.title,
      artist: row.artist ?? '',
      album: '',
      albumId: '',
      duration: 0,
      serverId: row.serverId,
    }]);
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
