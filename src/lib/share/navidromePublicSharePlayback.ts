import type { Track } from '@/lib/media/trackTypes';
import {
  buildNavidromePublicStreamUrl,
  buildNavidromePublicCoverUrl,
  type NavidromePublicShareRef,
} from '@/lib/share/navidromePublicShareUrl';
import type { NavidromePublicShareInfo } from '@/lib/share/navidromePublicShareTypes';

/** Synthetic queue server bucket for anonymous Navidrome public shares. */
export const NAVIDROME_PUBLIC_SHARE_SERVER_ID = 'navidrome-public-share';

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
