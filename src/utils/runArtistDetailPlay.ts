import type { TFunction } from 'i18next';
import { getAlbum } from '../api/subsonicLibrary';
import { getSimilarSongs2, getTopSongs } from '../api/subsonicArtists';
import type { SubsonicAlbum, SubsonicArtist } from '../api/subsonicTypes';
import type { Track } from '../store/playerStoreTypes';
import { songToTrack } from './songToTrack';

async function fetchAllTracks(albums: SubsonicAlbum[]): Promise<Track[]> {
  const results = await Promise.all(albums.map(a => getAlbum(a.id)));
  const sorted = [...results].sort((a, b) => (a.album.year ?? 0) - (b.album.year ?? 0));
  return sorted.flatMap(r => [...r.songs].sort((a, b) => (a.track ?? 0) - (b.track ?? 0))).map(songToTrack);
}

export interface RunArtistDetailPlayDeps {
  albums: SubsonicAlbum[];
  setPlayAllLoading: (v: boolean) => void;
  playTrack: (track: Track, queue: Track[]) => void;
}

export async function runArtistDetailPlayAll(deps: RunArtistDetailPlayDeps): Promise<void> {
  const { albums, setPlayAllLoading, playTrack } = deps;
  if (albums.length === 0) return;
  setPlayAllLoading(true);
  try {
    const tracks = await fetchAllTracks(albums);
    if (tracks.length > 0) playTrack(tracks[0], tracks);
  } finally {
    setPlayAllLoading(false);
  }
}

export async function runArtistDetailShuffle(deps: RunArtistDetailPlayDeps): Promise<void> {
  const { albums, setPlayAllLoading, playTrack } = deps;
  if (albums.length === 0) return;
  setPlayAllLoading(true);
  try {
    const tracks = await fetchAllTracks(albums);
    if (tracks.length > 0) {
      const shuffled = [...tracks].sort(() => Math.random() - 0.5);
      playTrack(shuffled[0], shuffled);
    }
  } finally {
    setPlayAllLoading(false);
  }
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
