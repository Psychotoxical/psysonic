import type { Track } from '../store/playerStoreTypes';

export interface BulkPlayDeps {
  songsLength: number;
  id: string | undefined;
  tracks: Track[];
  touchPlaylist: (id: string) => void;
  playTrack: (track: Track, queue: Track[]) => void;
  enqueue: (tracks: Track[]) => void;
}

export function playPlaylistAll(deps: BulkPlayDeps): void {
  const { songsLength, id, tracks, touchPlaylist, playTrack } = deps;
  if (!songsLength || !id) return;
  touchPlaylist(id);
  playTrack(tracks[0], tracks);
}

export function shufflePlaylistAll(deps: BulkPlayDeps): void {
  const { songsLength, id, tracks, touchPlaylist, playTrack } = deps;
  if (!songsLength || !id) return;
  touchPlaylist(id);
  const shuffled = [...tracks];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  playTrack(shuffled[0], shuffled);
}

export function enqueuePlaylistAll(deps: BulkPlayDeps): void {
  const { songsLength, id, tracks, touchPlaylist, enqueue } = deps;
  if (!songsLength || !id) return;
  touchPlaylist(id);
  enqueue(tracks);
}
