import type { TFunction } from 'i18next';
import { getSimilarSongs2, getTopSongs } from '@/lib/api/subsonicArtists';
import type { SubsonicAlbum, SubsonicArtist, SubsonicSong } from '@/lib/api/subsonicTypes';
import type { Track } from '@/lib/media/trackTypes';
import { songToTrack } from '@/lib/media/songToTrack';
import { runBulkPlayAll, runBulkShuffle } from '@/features/playback/utils/playback/runBulkPlay';
import { resolveAlbum, resolveMediaServerId } from '@/features/offline';

/** Ordered artist discography tracks for play-all / shuffle (network or local bytes). */
export async function fetchArtistDetailTracks(
  albums: SubsonicAlbum[],
  serverId?: string | null,
): Promise<Track[]> {
  const sid = resolveMediaServerId(serverId ?? albums[0]?.serverId);
  if (!sid) return [];

  const loaded = await Promise.all(albums.map(a => resolveAlbum(sid, a.id)));
  const sorted = loaded
    .filter((r): r is NonNullable<typeof r> => r != null)
    .sort((a, b) => (a.album.year ?? 0) - (b.album.year ?? 0));
  return sorted.flatMap(r =>
    [...r.songs].sort((a, b) => (a.track ?? 0) - (b.track ?? 0)).map(songToTrack),
  );
}

export interface RunArtistDetailPlayDeps {
  albums: SubsonicAlbum[];
  serverId?: string | null;
  setPlayAllLoading: (v: boolean) => void;
  playTrack: (track: Track, queue: Track[]) => void;
}

export async function runArtistDetailPlayAll(deps: RunArtistDetailPlayDeps): Promise<void> {
  const { albums, serverId, setPlayAllLoading, playTrack } = deps;
  if (albums.length === 0) return;
  await runBulkPlayAll({
    fetchTracks: () => fetchArtistDetailTracks(albums, serverId),
    setLoading: setPlayAllLoading,
    playTrack,
  });
}

export interface RunArtistDetailPlayTopSongDeps {
  topSongs: SubsonicSong[];
  albums: SubsonicAlbum[];
  serverId?: string | null;
  startIndex: number;
  setPlayAllLoading: (v: boolean) => void;
  playTrack: (track: Track, queue: Track[]) => void;
}

/** Play from a top-track row, then continue with the rest of the artist catalog when available. */
export async function runArtistDetailPlayTopSong(deps: RunArtistDetailPlayTopSongDeps): Promise<void> {
  const { topSongs, albums, serverId, startIndex, setPlayAllLoading, playTrack } = deps;
  if (topSongs.length === 0 || startIndex < 0 || startIndex >= topSongs.length) return;

  setPlayAllLoading(true);
  try {
    const topTracksFromIndex = topSongs.slice(startIndex).map(songToTrack);
    const topSongIds = new Set(topSongs.map(s => s.id));

    let remainingTracks: Track[] = [];
    if (albums.length > 0) {
      const allTracks = await fetchArtistDetailTracks(albums, serverId);
      remainingTracks = allTracks.filter(tr => !topSongIds.has(tr.id));
    }

    const queue = [...topTracksFromIndex, ...remainingTracks];
    if (queue.length > 0) playTrack(queue[0], queue);
  } finally {
    setPlayAllLoading(false);
  }
}

export async function runArtistDetailShuffle(deps: RunArtistDetailPlayDeps): Promise<void> {
  const { albums, serverId, setPlayAllLoading, playTrack } = deps;
  if (albums.length === 0) return;
  await runBulkShuffle({
    fetchTracks: () => fetchArtistDetailTracks(albums, serverId),
    setLoading: setPlayAllLoading,
    playTrack,
  });
}

export interface RunArtistDetailStartRadioDeps {
  artist: SubsonicArtist;
  t: TFunction;
  setRadioLoading: (v: boolean) => void;
  playTrack: (track: Track, queue: Track[]) => void;
  enqueue: (tracks: Track[]) => void;
}

export async function runArtistDetailStartRadio(deps: RunArtistDetailStartRadioDeps): Promise<void> {
  const { artist, t, setRadioLoading, playTrack, enqueue } = deps;
  setRadioLoading(true);
  try {
    // Fire both fetches in parallel
    const topPromise = getTopSongs(artist.name);
    const similarPromise = getSimilarSongs2(artist.id, 50);

    // Start playing as soon as top songs arrive
    const top = await topPromise;
    if (top.length > 0) {
      const firstTrack = songToTrack(top[0]);
      playTrack(firstTrack, [firstTrack]);
      setRadioLoading(false);
      // Enqueue remaining tracks when similar songs arrive
      const similar = await similarPromise;
      const remaining = [...top.slice(1), ...similar].map(songToTrack);
      if (remaining.length > 0) enqueue(remaining);
    } else {
      // No top songs — fall back to similar
      const similar = await similarPromise;
      if (similar.length > 0) {
        const tracks = similar.map(songToTrack);
        playTrack(tracks[0], tracks);
      } else {
        alert(t('artistDetail.noRadio'));
      }
      setRadioLoading(false);
    }
  } catch (e) {
    console.error('Radio start failed', e);
    setRadioLoading(false);
  }
}
