import type { QueueItemRef } from '../../store/playerStoreTypes';
import type { PlaySessionRecentTrack } from '../../api/library';
import type { TimelinePlayedRef } from '../../store/timelineSessionHistory';
import type { Track } from '../../store/playerStoreTypes';

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
