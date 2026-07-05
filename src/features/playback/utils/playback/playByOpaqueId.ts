import { getSong } from '@/lib/api/subsonicLibrary';
import { resolveAlbumForActiveServer } from '@/store/mediaResolver';
import { songToTrack } from '@/lib/media/songToTrack';
import { playAlbum } from '@/features/playback/utils/playback/playAlbum';
import { playArtistShuffled } from '@/features/playback/utils/playback/playArtistShuffled';
import { usePlayerStore } from '@/features/playback/store/playerStore';
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

  const albumData = await resolveAlbumForActiveServer(trimmed);
  if (albumData && albumData.songs.length > 0) {
    await playAlbum(trimmed);
    return;
  }

  try {
    await playArtistShuffled(trimmed);
  } catch {
    throw new Error('play_by_id_not_found');
  }
}
