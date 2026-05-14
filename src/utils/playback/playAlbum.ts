import { getAlbum } from '../../api/subsonicLibrary';
import { usePlayerStore } from '../../store/playerStore';
import { songToTrack } from './songToTrack';
import { useOrbitStore } from '../../store/orbitStore';

function fadeOut(setVolume: (v: number) => void, from: number, durationMs: number): Promise<void> {
  return new Promise(resolve => {
    const steps = 16;
    const stepMs = durationMs / steps;
    let step = 0;
    const id = setInterval(() => {
      step++;
      setVolume(Math.max(0, from * (1 - step / steps)));
      if (step >= steps) {
        clearInterval(id);
        resolve();
      }
    }, stepMs);
  });
}

export async function playAlbum(albumId: string): Promise<void> {
  const albumData = await getAlbum(albumId);
  const albumGenre = albumData.album.genre;
  const tracks = albumData.songs.map(s => {
    const track = songToTrack(s);
    if (!track.genre && albumGenre) track.genre = albumGenre;
    return track;
  });
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
