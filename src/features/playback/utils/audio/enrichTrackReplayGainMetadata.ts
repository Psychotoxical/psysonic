import { libraryGetTrack } from '@/lib/api/library';
import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { isReplayGainActive } from '@/features/playback/store/loudnessGainCache';
import { trackToSong } from '@/lib/library/trackDtoMapping';
import { libraryIsReady } from '@/lib/library/libraryReady';
import { songToTrack } from '@/lib/media/songToTrack';
import type { Track } from '@/lib/media/trackTypes';

async function resolveSongMetaFromIndexForPlaybackEnrich(
  serverId: string,
  songId: string,
): Promise<SubsonicSong | null> {
  if (!await libraryIsReady(serverId)) return null;
  try {
    const dto = await libraryGetTrack(serverId, songId);
    if (dto) return trackToSong(dto);
  } catch { /* index unavailable */ }
  return null;
}

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
 * Prefetch playback metadata (thin fields + ReplayGain) from the local index
 * before binding the engine on stream / gapless paths. Network fallback stays
 * in the queue resolver / {@link resolveSongMetaIndexFirst} path.
 */
export async function enrichTrackPlaybackMetadata(
  track: Track,
  serverId: string,
): Promise<Track> {
  if (!serverId) return track;
  const needsPrefetch = trackNeedsPlaybackMetadataPrefetch(track);
  const rgRecheck = isReplayGainActive()
    && !needsPrefetch
    && (track.replayGainTrackDb != null
      || track.replayGainAlbumDb != null
      || track.replayGainPeak != null);
  if (!needsPrefetch && !rgRecheck) return track;
  const song = await resolveSongMetaFromIndexForPlaybackEnrich(serverId, track.id);
  if (!song) return track;
  return mergePlaybackTrackMetadata(track, songToTrack(song));
}
