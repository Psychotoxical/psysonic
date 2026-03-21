import { getAlbum } from '../api/subsonic';
import { usePlayerStore } from '../store/playerStore';
import { songToTrack } from '../store/playerStore';

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
  const tracks = albumData.songs.map(songToTrack);
  if (!tracks.length) return;

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
