import { resolveAlbum, resolveArtist, resolveMediaServerId } from '@/store/mediaResolver';
import { songToTrack } from '@/lib/media/songToTrack';
import { shuffleArray } from '@/lib/util/shuffleArray';
import { usePlayerStore } from '@/features/playback/store/playerStore';
/**
 * All tracks from the artist’s albums, shuffled — same idea as Artist page “shuffle play”.
 */
export async function playArtistShuffled(artistId: string, serverId?: string): Promise<void> {
  const sid = resolveMediaServerId(serverId);
  if (!sid) throw new Error('play_artist_no_tracks');

  const artistData = await resolveArtist(sid, artistId);
  if (!artistData || artistData.albums.length === 0) {
    throw new Error('play_artist_no_tracks');
  }

  const results = await Promise.all(artistData.albums.map(a => resolveAlbum(sid, a.id)));
  const sorted = results
    .filter((r): r is NonNullable<typeof r> => r != null)
    .sort((a, b) => (a.album.year ?? 0) - (b.album.year ?? 0));
  const tracks = sorted.flatMap(r =>
    [...r.songs].sort((a, b) => (a.track ?? 0) - (b.track ?? 0)).map(songToTrack),
  );

  if (tracks.length === 0) {
    throw new Error('play_artist_no_tracks');
  }

  const shuffled = shuffleArray(tracks);
  usePlayerStore.getState().playTrack(shuffled[0], shuffled);
}
