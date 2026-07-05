import { getPlaylist } from '@/lib/api/subsonicPlaylists';
import { songToTrack } from '@/lib/media/songToTrack';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { playPlaylistAll } from '@/features/playlist/utils/playlistBulkPlayActions';

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
  playPlaylistAll({ songsLength: tracks.length, id, tracks, playTrack, enqueue });
}
