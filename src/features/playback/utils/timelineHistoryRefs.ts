import type { QueueItemRef } from '@/lib/media/trackTypes';
import type { PlaySessionRecentTrack } from '@/lib/api/library';
import type { TimelinePlayedRef } from '@/features/playback/store/timelineSessionHistory';
import type { Track } from '@/lib/media/trackTypes';

export function timelineHistoryToQueueRefs(
  history: TimelinePlayedRef[],
): QueueItemRef[] {
  return history.map(row => ({ serverId: row.serverId, trackId: row.trackId }));
}

export function bootstrapTrackFromPlaySession(row: PlaySessionRecentTrack): Track {
  const albumId = row.albumId ?? '';
  const coverArt = row.coverArtId ?? albumId;
  return {
    id: row.trackId,
    title: row.title,
    artist: row.artist ?? '',
    album: row.album ?? '',
    albumId,
    coverArt,
    duration: 0,
    serverId: row.serverId,
  };
}
