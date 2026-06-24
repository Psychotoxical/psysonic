import { getPlaylist } from '../../api/subsonicPlaylists';
import { songToTrack } from '../playback/songToTrack';
import { usePlayerStore } from '../../store/playerStore';
import { usePlaylistStore } from '../../store/playlistStore';
import { playPlaylistAll } from './playlistBulkPlayActions';

/**
 * Load a playlist's songs and start playback immediately ("Play Now").
 *
 * Used where only the playlist metadata is on hand — the playlist context menu
 * on the Playlists overview — so the tracks have to be fetched first. Once
 * loaded it defers to {@link playPlaylistAll}, the same action the playlist
 * detail "Play All" button uses, so playback behaviour stays in one place.
 */
export async function playPlaylistById(id: string): Promise<void> {
  const { songs } = await getPlaylist(id);
  const tracks = songs.map(songToTrack);
  const { playTrack, enqueue } = usePlayerStore.getState();
  const { touchPlaylist } = usePlaylistStore.getState();
  playPlaylistAll({ songsLength: tracks.length, id, tracks, touchPlaylist, playTrack, enqueue });
}
