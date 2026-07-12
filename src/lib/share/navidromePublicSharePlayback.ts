import type { Track } from '@/lib/media/trackTypes';
import type { QueueItemRef } from '@/lib/media/trackTypes';
import {
  buildNavidromePublicStreamUrl,
  buildNavidromePublicCoverUrl,
  type NavidromePublicShareRef,
} from '@/lib/share/navidromePublicShareUrl';
import type { NavidromePublicShareInfo } from '@/lib/share/navidromePublicShareTypes';

/** Synthetic queue server bucket for anonymous Navidrome public shares. */
export const NAVIDROME_PUBLIC_SHARE_SERVER_ID = 'navidrome-public-share';

export function isPublicShareTrackId(trackId: string | null | undefined): boolean {
  return typeof trackId === 'string' && trackId.startsWith('ndshare:');
}

export function navidromePublicShareToTracks(
  ref: NavidromePublicShareRef,
  info: NavidromePublicShareInfo,
): Track[] {
  return info.tracks.map((t, index) => ({
    id: `ndshare:${info.id}:${index}`,
    title: t.title,
    artist: t.artist,
    album: t.album,
    albumId: '',
    duration: t.duration,
    serverId: NAVIDROME_PUBLIC_SHARE_SERVER_ID,
    directStreamUrl: buildNavidromePublicStreamUrl(ref, t.id),
    directCoverArtUrl: buildNavidromePublicCoverUrl(ref, t.id),
  }));
}

/** True while a Navidrome public share queue is live in this session. */
export function isActivePublicShareQueue(
  queueServerId: string | null | undefined,
  queueItems: QueueItemRef[],
): boolean {
  if (queueItems.length === 0) return false;
  if (queueServerId === NAVIDROME_PUBLIC_SHARE_SERVER_ID) return true;
  return queueItems.some(
    r => r.serverId === NAVIDROME_PUBLIC_SHARE_SERVER_ID || isPublicShareTrackId(r.trackId),
  );
}

export function isPublicSharePersistedTrack(track: Track | null | undefined): boolean {
  if (!track) return false;
  return track.serverId === NAVIDROME_PUBLIC_SHARE_SERVER_ID || isPublicShareTrackId(track.id);
}

export function tracksArePublicShareQueue(
  tracks: ReadonlyArray<Pick<Track, 'id' | 'serverId'>>,
): boolean {
  return tracks.length > 0
    && tracks.every(t =>
      t.serverId === NAVIDROME_PUBLIC_SHARE_SERVER_ID || isPublicShareTrackId(t.id),
    );
}
