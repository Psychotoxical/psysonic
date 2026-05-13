import React, { useEffect, useState } from 'react';
import type { SubsonicSong } from '../api/subsonicTypes';
import { useDragDrop } from '../contexts/DragDropContext';
import { runPlaylistReorderDrop } from '../utils/runPlaylistReorderDrop';

export interface PlaylistDnDReorderDeps {
  tracklistRef: React.RefObject<HTMLDivElement | null>;
  songs: SubsonicSong[];
  savePlaylist: (updatedSongs: SubsonicSong[], prevCount?: number) => Promise<void>;
  setSongs: React.Dispatch<React.SetStateAction<SubsonicSong[]>>;
}

export interface PlaylistDnDReorderResult {
  dropTargetIdx: { idx: number; before: boolean } | null;
  setDropTargetIdx: React.Dispatch<React.SetStateAction<{ idx: number; before: boolean } | null>>;
  handleRowMouseEnter: (idx: number, e: React.MouseEvent) => void;
}

export function usePlaylistDnDReorder(deps: PlaylistDnDReorderDeps): PlaylistDnDReorderResult {
  const { tracklistRef, songs, savePlaylist, setSongs } = deps;
  const { isDragging } = useDragDrop();
  const [dropTargetIdx, setDropTargetIdx] = useState<{ idx: number; before: boolean } | null>(null);

  useEffect(() => {
    const container = tracklistRef.current;
    if (!container) return;

    const onPsyDrop = (e: Event) => {
      runPlaylistReorderDrop({ e, songs, savePlaylist, setDropTargetIdx, setSongs });
    };

    container.addEventListener('psy-drop', onPsyDrop);
    return () => container.removeEventListener('psy-drop', onPsyDrop);
  }, [songs, savePlaylist, tracklistRef, setSongs]);

  const handleRowMouseEnter = (idx: number, e: React.MouseEvent) => {
    if (!isDragging) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    setDropTargetIdx({ idx, before });
  };

  return { dropTargetIdx, setDropTargetIdx, handleRowMouseEnter };
}
