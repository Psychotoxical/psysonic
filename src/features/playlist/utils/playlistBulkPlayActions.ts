import type { Track } from '@/lib/media/trackTypes';

// No `touchPlaylist` here: playing/shuffling/enqueuing does not modify the
// playlist. Touching it bumps `lastModified`, which is the playlist detail
// page's load-effect trigger, so it would re-fetch and flash the whole
// container on every Play click. Real mutations (add/remove/save) still touch.
export interface BulkPlayDeps {
  songsLength: number;
  id: string | undefined;
  tracks: Track[];
  playTrack: (track: Track, queue: Track[]) => void;
  enqueue: (tracks: Track[]) => void;
}

export function playPlaylistAll(deps: BulkPlayDeps): void {
  const { songsLength, id, tracks, playTrack } = deps;
  if (!songsLength || !id) return;
  playTrack(tracks[0], tracks);
}

export function shufflePlaylistAll(deps: BulkPlayDeps): void {
  const { songsLength, id, tracks, playTrack } = deps;
  if (!songsLength || !id) return;
  const shuffled = [...tracks];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  playTrack(shuffled[0], shuffled);
}

export function enqueuePlaylistAll(deps: BulkPlayDeps): void {
  const { songsLength, id, tracks, enqueue } = deps;
  if (!songsLength || !id) return;
  enqueue(tracks);
}
