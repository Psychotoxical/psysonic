import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import type { Track } from '@/lib/media/trackTypes';
import { coerceOpenArtistRefs } from '@/lib/api/openArtistRefs';
import { activeServerProfileId } from '@/lib/media/trackServerScope';

export function songToTrack(song: SubsonicSong): Track {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    albumId: song.albumId,
    artistId: song.artistId,
    artists: (() => {
      const artists = coerceOpenArtistRefs(song.artists);
      return artists.length > 0 ? artists : undefined;
    })(),
    duration: song.duration,
    coverArt: song.coverArt,
    discNumber: song.discNumber,
    track: song.track,
    year: song.year,
    bitRate: song.bitRate,
    suffix: song.suffix,
    userRating: song.userRating,
    replayGainTrackDb: song.replayGain?.trackGain,
    replayGainAlbumDb: song.replayGain?.albumGain,
    replayGainPeak: song.replayGain?.trackPeak,
    starred: song.starred,
    genre: song.genre,
    samplingRate: song.samplingRate,
    bitDepth: song.bitDepth,
    size: song.size,
    serverId: song.serverId ?? activeServerProfileId(),
  };
}
