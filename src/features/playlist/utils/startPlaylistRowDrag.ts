import type { SubsonicSong } from '@/lib/api/subsonicTypes';
import { songToTrack } from '@/lib/media/songToTrack';

export interface StartPlaylistRowDragDeps {
  /** The `mousemove` that carried the press past the drag threshold. */
  me: MouseEvent;
  idx: number;
  songs: SubsonicSong[];
  selectedIds: Set<string>;
  isFiltered: boolean;
  startDrag: (payload: { data: string; label: string }, x: number, y: number) => void;
}

/**
 * Picks the payload a playlist row drags and starts the drag. Which of the three
 * it is depends on the selection and whether a filter is narrowing the list, so
 * it is read here rather than when the press was armed.
 *
 * Arming and resolving the press belongs to `useDragPress` — see
 * `src/lib/dnd/useDragPress.ts`.
 */
export function startPlaylistRowDrag(deps: StartPlaylistRowDragDeps): void {
  const { me, idx, songs, selectedIds, isFiltered, startDrag } = deps;
  if (!isFiltered && selectedIds.has(songs[idx]?.id) && selectedIds.size > 1) {
    const bulkTracks = songs.filter(s => selectedIds.has(s.id)).map(songToTrack);
    startDrag({ data: JSON.stringify({ type: 'songs', tracks: bulkTracks }), label: `${bulkTracks.length} Songs` }, me.clientX, me.clientY);
  } else if (!isFiltered) {
    startDrag(
      { data: JSON.stringify({ type: 'playlist_reorder', index: idx }), label: songs[idx]?.title ?? '' },
      me.clientX, me.clientY
    );
  } else {
    // filtered view: single-song drag to queue
    startDrag(
      { data: JSON.stringify({ type: 'song', track: songToTrack(songs[idx]) }), label: songs[idx]?.title ?? '' },
      me.clientX, me.clientY
    );
  }
}
