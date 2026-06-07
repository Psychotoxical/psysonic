import { usePlayerStore } from '../../store/playerStore';
import { resolveAlbumForActiveServer } from '../offline/offlineMediaResolve';
import { songToTrack } from './songToTrack';
import { useOrbitStore } from '../../store/orbitStore';
import { fadeOut } from './fadeOut';
import type { Track } from '../../store/playerStoreTypes';
import { shuffleArray } from './shuffleArray';

export async function fetchAlbumTracks(albumId: string, serverId?: string): Promise<Track[]> {
  const albumData = await resolveAlbumForActiveServer(albumId, serverId);
  if (!albumData) throw new Error(`Album ${albumId} not available`);
  const albumGenre = albumData.album.genre;
  const ownerServerId = serverId ?? albumData.album.serverId;
  return albumData.songs.map(s => {
    const track = songToTrack(s);
    if (ownerServerId) track.serverId = ownerServerId;
    if (!track.genre && albumGenre) track.genre = albumGenre;
    return track;
  });
}

async function startAlbumPlayback(tracks: Track[]): Promise<void> {
  if (!tracks.length) return;

  // In Orbit sessions, playAlbum is effectively an append operation (the
  // playerStore bulk-gate also routes replaces into enqueue). Skip the
  // fadeOut entirely — the current track keeps playing, the album goes
  // onto the end of the queue after the user confirms the bulk dialog.
  const orbitRole = useOrbitStore.getState().role;
  if (orbitRole === 'host' || orbitRole === 'guest') {
    usePlayerStore.getState().enqueue(tracks);
    return;
  }

  const store = usePlayerStore.getState();
  const { isPlaying, volume } = store;

  if (isPlaying) {
    await fadeOut(store.setVolume, volume, 700);
    // Restore volume only in the Zustand store — do NOT call audio_set_volume here,
    // otherwise the old track glitches back to full volume before playTrack stops it.
    // playTrack reads state.volume and passes it to audio_play, so the new track
    // starts at the correct volume without the Rust engine ever hearing a restore.
    usePlayerStore.setState({ volume });
  }

  usePlayerStore.getState().playTrack(tracks[0], tracks);
}

export async function playAlbum(albumId: string, opts?: { serverId?: string }): Promise<void> {
  await startAlbumPlayback(await fetchAlbumTracks(albumId, opts?.serverId));
}

export async function playAlbumShuffled(albumId: string, opts?: { serverId?: string }): Promise<void> {
  await startAlbumPlayback(shuffleArray(await fetchAlbumTracks(albumId, opts?.serverId)));
}
