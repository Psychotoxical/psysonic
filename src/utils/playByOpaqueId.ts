import { getAlbum, getSong } from '../api/subsonicLibrary';
import { songToTrack } from '../utils/songToTrack';
import { playAlbum } from './playAlbum';
import { playArtistShuffled } from './playArtistShuffled';
import { usePlayerStore } from '../store/playerStore';
/**
 * `getSong` → `getAlbum` → `getArtist`: one opaque Subsonic id may refer to a track,
 * album, or artist depending on the server.
 */
export async function playByOpaqueId(id: string): Promise<void> {
  const trimmed = id.trim();
  if (!trimmed) return;

  const song = await getSong(trimmed);
  if (song) {
    usePlayerStore.getState().playTrack(songToTrack(song));
    return;
  }

  try {
    const { songs } = await getAlbum(trimmed);
    if (songs.length > 0) {
      await playAlbum(trimmed);
      return;
    }
  } catch {
    /* not an album */
  }

  try {
    await playArtistShuffled(trimmed);
  } catch {
    throw new Error('play_by_id_not_found');
  }
}
