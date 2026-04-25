import { usePlayerStore, songToTrack } from '../store/playerStore';
import type { SubsonicSong } from '../api/subsonic';

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

/**
 * Play a single song. When `queue` is provided, surrounds the chosen song with that queue
 * so Next/Prev work — pass the rail / pool the click came from. Mirrors playAlbum's fade-out.
 */
export async function playSongNow(song: SubsonicSong, queue?: SubsonicSong[]): Promise<void> {
  const track = songToTrack(song);
  const tracks = queue && queue.length > 0
    ? queue.map(songToTrack)
    : [track];

  const store = usePlayerStore.getState();
  const { isPlaying, volume } = store;

  if (isPlaying) {
    await fadeOut(store.setVolume, volume, 700);
    usePlayerStore.setState({ volume });
  }

  usePlayerStore.getState().playTrack(track, tracks);
}

/**
 * Append the song to the existing queue (if not already there) and immediately jump to it.
 * Existing queue stays intact — different from playSongNow which replaces the queue.
 */
export async function enqueueAndPlay(song: SubsonicSong): Promise<void> {
  const track = songToTrack(song);
  const store = usePlayerStore.getState();
  const { isPlaying, volume, queue } = store;

  if (isPlaying) {
    await fadeOut(store.setVolume, volume, 700);
    usePlayerStore.setState({ volume });
  }

  if (!queue.some(t => t.id === track.id)) {
    usePlayerStore.getState().enqueue([track]);
  }
  // playTrack with no queue arg uses the current state.queue, finds the track by id,
  // and sets queueIndex accordingly.
  usePlayerStore.getState().playTrack(track);
}
