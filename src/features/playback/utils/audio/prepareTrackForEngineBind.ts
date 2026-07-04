import type { Track } from '@/lib/media/trackTypes';
import { enrichTrackPlaybackMetadata } from '@/features/playback/utils/audio/enrichTrackReplayGainMetadata';
import { refreshLoudnessForTrack } from '@/features/playback/store/loudnessRefresh';

/**
 * Index-first metadata + loudness cache before `audio_play` / `audio_chain_preload`.
 * Awaits loudness refresh so normalization gain is ready for the bind payload.
 */
export async function prepareTrackForEngineBind(
  track: Track,
  serverId: string,
): Promise<Track> {
  const enriched = serverId
    ? await enrichTrackPlaybackMetadata(track, serverId)
    : track;
  await refreshLoudnessForTrack(enriched.id, { syncPlayingEngine: false });
  return enriched;
}
