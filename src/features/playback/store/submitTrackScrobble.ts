import { scrobbleSong } from '@/lib/api/subsonicScrobble';
import type { QueueItemRef, Track } from '@/lib/media/trackTypes';
import { getMusicNetworkRuntimeOrNull } from '@/music-network';
import { playbackProfileIdForTrack } from '@/features/playback/utils/playback/playbackServer';

/** Submit one play to the owning media server and every enabled Music Network destination. */
export function submitTrackScrobble(track: Track, queueRef?: QueueItemRef): void {
  scrobbleSong(
    track.id,
    Date.now(),
    playbackProfileIdForTrack(track, queueRef),
  );
  void getMusicNetworkRuntimeOrNull()?.dispatchScrobble({
    title: track.title,
    artist: track.artist,
    album: track.album,
    duration: track.duration,
    timestamp: Date.now(),
  });
}
