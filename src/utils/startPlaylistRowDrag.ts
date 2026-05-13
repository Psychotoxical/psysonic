import type React from 'react';
import type { SubsonicSong } from '../api/subsonicTypes';
import { songToTrack } from './songToTrack';

export interface StartPlaylistRowDragDeps {
  e: React.MouseEvent;
  idx: number;
  songs: SubsonicSong[];
  selectedIds: Set<string>;
  isFiltered: boolean;
  startDrag: (payload: { data: string; label: string }, x: number, y: number) => void;
}

export function startPlaylistRowDrag(deps: StartPlaylistRowDragDeps): void {
  const { e, idx, songs, selectedIds, isFiltered, startDrag } = deps;
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest('button, input')) return;
  e.preventDefault();
  const sx = e.clientX, sy = e.clientY;
  const onMove = (me: MouseEvent) => {
    if (Math.abs(me.clientX - sx) > 5 || Math.abs(me.clientY - sy) > 5) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
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
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
