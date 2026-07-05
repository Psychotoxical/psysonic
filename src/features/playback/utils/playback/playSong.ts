import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { songToTrack } from '@/lib/media/songToTrack';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { fadeOut } from '@/features/playback/utils/playback/fadeOut';
import { shouldAutodjInterruptBlend } from '@/features/playback/utils/playback/autodjManualBlend';

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

  if (isPlaying && !shouldAutodjInterruptBlend(true)) {
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
  const { isPlaying, volume, queueItems } = store;

  if (isPlaying && !shouldAutodjInterruptBlend(true)) {
    await fadeOut(store.setVolume, volume, 700);
    usePlayerStore.setState({ volume });
  }

  if (!queueItems.some(r => r.trackId === track.id)) {
    usePlayerStore.getState().enqueue([track]);
  }
  // playTrack with no queue arg uses the current state.queue, finds the track by id,
  // and sets queueIndex accordingly.
  usePlayerStore.getState().playTrack(track);
}
