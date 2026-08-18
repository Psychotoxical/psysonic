import { scrobbleSong } from '@/lib/api/subsonicScrobble';
import type { Track } from '@/lib/media/trackTypes';
import { getMusicNetworkRuntimeOrNull } from '@/music-network';

/** Submit one play to the owning media server and every enabled Music Network destination. */
export function submitTrackScrobble(
  track: Track,
  serverId: string,
  startedAtMs: number,
): void {
  void scrobbleSong(track.id, startedAtMs, serverId);
  void getMusicNetworkRuntimeOrNull()?.dispatchScrobble({
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    timestamp: startedAtMs,
  });
}
