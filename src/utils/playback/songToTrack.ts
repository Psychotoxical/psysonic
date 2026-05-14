import type { SubsonicSong } from '../../api/subsonicTypes';
import type { Track } from '../../store/playerStoreTypes';
export function songToTrack(song: SubsonicSong): Track {
  return {
    id: song.id,
    title: song.title,
    artist: song.artist,
    album: song.album,
    albumId: song.albumId,
    artistId: song.artistId,
    artists: song.artists && song.artists.length > 0 ? song.artists : undefined,
    duration: song.duration,
    coverArt: song.coverArt,
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
  };
}
