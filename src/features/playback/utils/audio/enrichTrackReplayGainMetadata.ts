import { getSongForServer } from '@/lib/api/subsonicLibrary';
import { resolveSongMetaIndexFirst } from '@/lib/library/resolveSongMetaIndexFirst';
import { isReplayGainActive } from '@/features/playback/store/loudnessGainCache';
import { songToTrack } from '@/lib/media/songToTrack';
import type { Track } from '@/lib/media/trackTypes';

/** True when ReplayGain is on and the track snapshot has no gain tags yet. */
export function trackNeedsReplayGainMetadataPrefetch(track: Track): boolean {
  if (!isReplayGainActive()) return false;
  return track.replayGainTrackDb == null && track.replayGainAlbumDb == null;
}

/** True when index/getSong prefetch would improve a thin snapshot or ReplayGain tags. */
export function trackNeedsPlaybackMetadataPrefetch(track: Track): boolean {
  if (track.title === '…' || track.duration === 0) return true;
  if (trackNeedsReplayGainMetadataPrefetch(track)) return true;
  return isReplayGainActive() && track.replayGainPeak == null
    && (track.replayGainTrackDb != null || track.replayGainAlbumDb != null);
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
 * Prefetch playback metadata (thin fields + ReplayGain) via index → getSong
 * before binding the engine on stream / gapless paths.
 */
export async function enrichTrackPlaybackMetadata(
  track: Track,
  serverId: string,
): Promise<Track> {
  if (!trackNeedsPlaybackMetadataPrefetch(track) || !serverId) return track;
  const song = await resolveSongMetaIndexFirst(serverId, track.id);
  if (!song) return track;
  let merged = mergePlaybackTrackMetadata(track, songToTrack(song));
  if (
    isReplayGainActive()
    && merged.replayGainPeak == null
    && (merged.replayGainTrackDb != null || merged.replayGainAlbumDb != null)
  ) {
    const networkSong = await getSongForServer(serverId, track.id);
    const peak = networkSong?.replayGain?.trackPeak;
    if (peak != null) {
      merged = { ...merged, replayGainPeak: peak };
    }
  }
  return merged;
}
