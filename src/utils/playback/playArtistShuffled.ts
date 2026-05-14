import { getArtist } from '../../api/subsonicArtists';
import { getAlbum } from '../../api/subsonicLibrary';
import { songToTrack } from './songToTrack';
import { shuffleArray } from './shuffleArray';
import { usePlayerStore } from '../../store/playerStore';
/**
 * All tracks from the artist’s albums, shuffled — same idea as Artist page “shuffle play”.
 */
export async function playArtistShuffled(artistId: string): Promise<void> {
  const { albums } = await getArtist(artistId);
  if (albums.length === 0) {
    throw new Error('play_artist_no_tracks');
  }

  const results = await Promise.all(albums.map(a => getAlbum(a.id)));
  const sorted = [...results].sort((a, b) => (a.album.year ?? 0) - (b.album.year ?? 0));
  const tracks = sorted.flatMap(r =>
    [...r.songs].sort((a, b) => (a.track ?? 0) - (b.track ?? 0)).map(songToTrack),
  );

  if (tracks.length === 0) {
    throw new Error('play_artist_no_tracks');
  }

  const shuffled = shuffleArray(tracks);
  usePlayerStore.getState().playTrack(shuffled[0], shuffled);
}
