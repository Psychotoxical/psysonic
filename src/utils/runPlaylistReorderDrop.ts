import type React from 'react';
import type { SubsonicSong } from '../api/subsonicTypes';

export interface RunPlaylistReorderDropDeps {
  e: Event;
  songs: SubsonicSong[];
  savePlaylist: (next: SubsonicSong[], prevCount?: number) => Promise<void>;
  setDropTargetIdx: React.Dispatch<React.SetStateAction<{ idx: number; before: boolean } | null>>;
  setSongs: React.Dispatch<React.SetStateAction<SubsonicSong[]>>;
}

export function runPlaylistReorderDrop(deps: RunPlaylistReorderDropDeps): void {
  const { e, songs, savePlaylist, setDropTargetIdx, setSongs } = deps;
  const detail = (e as CustomEvent).detail;
  if (!detail?.data) return;
  let parsed: any;
  try { parsed = JSON.parse(detail.data); } catch { return; }
  if (parsed.type !== 'playlist_reorder') return;

  setDropTargetIdx(null);

  const fromIdx: number = parsed.index;

  // Determine drop index from the event target row
  const target = (e.target as HTMLElement).closest('[data-track-idx]');
  let toIdx = songs.length;
  if (target) {
    const targetIdx = parseInt(target.getAttribute('data-track-idx') ?? '', 10);
    const rect = target.getBoundingClientRect();
    const cursorY = (e as CustomEvent & { clientY?: number }).clientY ?? (rect.top + rect.height / 2);
    const before = cursorY < rect.top + rect.height / 2;
    toIdx = before ? targetIdx : targetIdx + 1;
  }

  if (fromIdx === toIdx || fromIdx === toIdx - 1) return;

  setSongs(prev => {
    const next = [...prev];
    const [moved] = next.splice(fromIdx, 1);
    const insertAt = toIdx > fromIdx ? toIdx - 1 : toIdx;
    next.splice(insertAt, 0, moved);
    savePlaylist(next);
    return next;
  });
}
