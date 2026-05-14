import type React from 'react';
import type { TFunction } from 'i18next';
import { deletePlaylist, getPlaylist, updatePlaylist } from '../../api/subsonicPlaylists';
import type { SubsonicPlaylist } from '../../api/subsonicTypes';
import { usePlaylistStore } from '../../store/playlistStore';
import { showToast } from '../ui/toast';

export interface RunPlaylistDeleteDeps {
  e: React.MouseEvent;
  pl: SubsonicPlaylist;
  deleteConfirmId: string | null;
  setDeleteConfirmId: React.Dispatch<React.SetStateAction<string | null>>;
  removeId: (id: string) => void;
  t: TFunction;
}

export async function runPlaylistDelete(deps: RunPlaylistDeleteDeps): Promise<void> {
  const { e, pl, deleteConfirmId, setDeleteConfirmId, removeId, t } = deps;
  e.stopPropagation();
  if (deleteConfirmId !== pl.id) {
    setDeleteConfirmId(pl.id);
    const btn = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => {
      btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    return;
  }
  try {
    await deletePlaylist(pl.id);
    removeId(pl.id);
    usePlaylistStore.setState((s) => ({
      playlists: s.playlists.filter((p) => p.id !== pl.id),
    }));
    showToast(t('playlists.deleteSuccess', { count: 1 }), 3000, 'info');
  } catch {
    showToast(t('playlists.deleteFailed', { name: pl.name }), 3000, 'error');
  }
  setDeleteConfirmId(null);
}

export interface RunPlaylistDeleteSelectedDeps {
  selectedPlaylists: SubsonicPlaylist[];
  selectedIds: Set<string>;
  isPlaylistDeletable: (pl: SubsonicPlaylist) => boolean;
  removeId: (id: string) => void;
  clearSelection: () => void;
  t: TFunction;
}

export async function runPlaylistDeleteSelected(deps: RunPlaylistDeleteSelectedDeps): Promise<void> {
  const { selectedPlaylists, selectedIds, isPlaylistDeletable, removeId, clearSelection, t } = deps;
  const deletable = selectedPlaylists.filter(isPlaylistDeletable);
  if (deletable.length === 0) return;
  let deleted = 0;
  for (const pl of deletable) {
    try {
      await deletePlaylist(pl.id);
      removeId(pl.id);
      deleted++;
    } catch {
      showToast(t('playlists.deleteFailed', { name: pl.name }), 3000, 'error');
    }
  }
  usePlaylistStore.setState((s) => ({
    playlists: s.playlists.filter((p) => !(selectedIds.has(p.id) && isPlaylistDeletable(p))),
  }));
  clearSelection();
  if (deleted > 0) {
    showToast(t('playlists.deleteSuccess', { count: deleted }), 3000, 'info');
  }
}

export interface RunPlaylistMergeSelectedDeps {
  targetPlaylist: SubsonicPlaylist;
  selectedPlaylists: SubsonicPlaylist[];
  touchPlaylist: (id: string) => void;
  clearSelection: () => void;
  t: TFunction;
}

export async function runPlaylistMergeSelected(deps: RunPlaylistMergeSelectedDeps): Promise<void> {
  const { targetPlaylist, selectedPlaylists, touchPlaylist, clearSelection, t } = deps;
  if (selectedPlaylists.length === 0) return;
  try {
    const { songs: targetSongs } = await getPlaylist(targetPlaylist.id);
    const targetIds = new Set(targetSongs.map(s => s.id));
    let totalAdded = 0;

    for (const pl of selectedPlaylists) {
      if (pl.id === targetPlaylist.id) continue;
      const { songs } = await getPlaylist(pl.id);
      const newSongs = songs.filter(s => !targetIds.has(s.id));
      if (newSongs.length > 0) {
        newSongs.forEach(s => targetIds.add(s.id));
        totalAdded += newSongs.length;
      }
    }

    if (totalAdded > 0) {
      await updatePlaylist(targetPlaylist.id, Array.from(targetIds));
      touchPlaylist(targetPlaylist.id);
      showToast(t('playlists.mergeSuccess', { count: totalAdded, playlist: targetPlaylist.name }), 3000, 'info');
    } else {
      showToast(t('playlists.mergeNoNewSongs'), 3000, 'info');
    }
    clearSelection();
  } catch {
    showToast(t('playlists.mergeError'), 4000, 'error');
  }
}
