import type { Track } from '@/lib/media/trackTypes';
import { shuffleArray } from '@/lib/util/shuffleArray';

/**
 * Shared "play / shuffle / enqueue a fetched track list" core for detail pages whose
 * tracks are loaded asynchronously (Artist, Genre, …). The caller supplies `fetchTracks`;
 * everything else — loading flag, empty guard, shuffle — is uniform here so each page does
 * not grow its own divergent copy.
 */
export interface RunBulkPlayDeps {
  fetchTracks: () => Promise<Track[]>;
  setLoading: (v: boolean) => void;
  playTrack: (track: Track, queue: Track[]) => void;
}

export async function runBulkPlayAll(deps: RunBulkPlayDeps): Promise<void> {
  const { fetchTracks, setLoading, playTrack } = deps;
  setLoading(true);
  try {
    const tracks = await fetchTracks();
    if (tracks.length > 0) playTrack(tracks[0], tracks);
  } finally {
    setLoading(false);
  }
}

export async function runBulkShuffle(deps: RunBulkPlayDeps): Promise<void> {
  const { fetchTracks, setLoading, playTrack } = deps;
  setLoading(true);
  try {
    const shuffled = shuffleArray(await fetchTracks());
    if (shuffled.length > 0) playTrack(shuffled[0], shuffled);
  } finally {
    setLoading(false);
  }
}

export interface RunBulkEnqueueDeps {
  fetchTracks: () => Promise<Track[]>;
  setLoading: (v: boolean) => void;
  enqueue: (tracks: Track[]) => void;
}

export async function runBulkEnqueue(deps: RunBulkEnqueueDeps): Promise<void> {
  const { fetchTracks, setLoading, enqueue } = deps;
  setLoading(true);
  try {
    const tracks = await fetchTracks();
    if (tracks.length > 0) enqueue(tracks);
  } finally {
    setLoading(false);
  }
}
