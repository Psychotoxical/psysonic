import type { QueueItemRef } from '@/lib/media/trackTypes';
import type { PlaySessionRecentTrack } from '@/lib/api/library';
import type { TimelinePlayedRef } from '@/features/playback/store/timelineSessionHistory';
import type { Track } from '@/lib/media/trackTypes';
import {
  canonicalizePlaybackTrack,
  canonicalizeQueueItemRef,
} from '@/features/playback/store/queueItemRef';

export function timelineHistoryToQueueRefs(
  history: TimelinePlayedRef[],
): QueueItemRef[] {
  return history.map(row => canonicalizeQueueItemRef({
    serverId: row.serverId,
    trackId: row.trackId,
  }));
}

export function bootstrapTrackFromPlaySession(row: PlaySessionRecentTrack): Track {
  const albumId = row.albumId ?? '';
  const coverArt = row.coverArtId ?? albumId;
  return canonicalizePlaybackTrack({
    id: row.trackId,
    title: row.title,
    artist: row.artist ?? '',
    album: row.album ?? '',
    albumId,
    coverArt,
    duration: 0,
    serverId: row.serverId,
  }, row.serverId);
}
