import type { Track } from '@/lib/media/trackTypes';
import { enrichTrackPlaybackMetadata } from '@/features/playback/utils/audio/enrichTrackReplayGainMetadata';

/**
 * Index-first metadata before `audio_play` / `audio_chain_preload`.
 * Callers in the playback store should await {@link refreshLoudnessForTrack}
 * separately so dependency-cruiser does not route utils → store → utils cycles.
 */
export async function prepareTrackForEngineBind(
  track: Track,
  serverId: string,
): Promise<Track> {
  return serverId
    ? enrichTrackPlaybackMetadata(track, serverId)
    : track;
}
