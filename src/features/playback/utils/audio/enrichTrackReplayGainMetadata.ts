import { resolveSongMetaIndexFirst } from '@/lib/library/resolveSongMetaIndexFirst';
import { isReplayGainActive } from '@/features/playback/store/loudnessGainCache';
import { songToTrack } from '@/lib/media/songToTrack';
import type { Track } from '@/lib/media/trackTypes';

/** True when ReplayGain is on and the track snapshot has no gain tags yet. */
export function trackNeedsReplayGainMetadataPrefetch(track: Track): boolean {
  if (!isReplayGainActive()) return false;
  return track.replayGainTrackDb == null && track.replayGainAlbumDb == null;
}

/** Merge resolver/index metadata onto a thin playback snapshot without dropping queue flags. */
export function mergePlaybackTrackMetadata(base: Track, resolved: Track): Track {
  const thin = base.title === '…' || base.duration === 0;
  return {
    ...(thin ? resolved : base),
    ...base,
    id: base.id,
    autoAdded: base.autoAdded,
    radioAdded: base.radioAdded,
    playNextAdded: base.playNextAdded,
    title: thin && resolved.title ? resolved.title : base.title,
    artist: thin && resolved.artist ? resolved.artist : base.artist,
    album: thin && resolved.album ? resolved.album : base.album,
    albumId: resolved.albumId || base.albumId,
    duration: resolved.duration > 0 ? resolved.duration : base.duration,
    replayGainTrackDb: resolved.replayGainTrackDb ?? base.replayGainTrackDb,
    replayGainAlbumDb: resolved.replayGainAlbumDb ?? base.replayGainAlbumDb,
    replayGainPeak: resolved.replayGainPeak ?? base.replayGainPeak,
    suffix: resolved.suffix ?? base.suffix,
    bitRate: resolved.bitRate ?? base.bitRate,
    samplingRate: resolved.samplingRate ?? base.samplingRate,
    bitDepth: resolved.bitDepth ?? base.bitDepth,
    coverArt: resolved.coverArt ?? base.coverArt,
    artistId: resolved.artistId ?? base.artistId,
    serverId: base.serverId ?? resolved.serverId,
  };
}

/**
 * Prefetch ReplayGain (and thin placeholder fields) via index → getSong before
 * binding gain on stream playback.
 */
export async function enrichTrackReplayGainMetadata(
  track: Track,
  serverId: string,
): Promise<Track> {
  if (!trackNeedsReplayGainMetadataPrefetch(track) || !serverId) return track;
  const song = await resolveSongMetaIndexFirst(serverId, track.id);
  if (!song) return track;
  return mergePlaybackTrackMetadata(track, songToTrack(song));
}
