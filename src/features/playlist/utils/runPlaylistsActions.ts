import type React from 'react';
import type { TFunction } from 'i18next';
import { deletePlaylist, addSongsToPlaylist } from '@/lib/api/subsonicPlaylists';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { usePlaylistStore } from '@/features/playlist/store/playlistStore';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';
import { collectMergeSongIds } from '@/features/playlist/utils/addTracksToPlaylistWithDedup';
import { showToast } from '@/lib/dom/toast';

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
  isPlaylistDeletable: (pl: SubsonicPlaylist) => boolean;
  removeId: (id: string) => void;
  clearSelection: () => void;
  t: TFunction;
}

export async function runPlaylistDeleteSelected(deps: RunPlaylistDeleteSelectedDeps): Promise<void> {
  const { selectedPlaylists, isPlaylistDeletable, removeId, clearSelection, t } = deps;
  const deletable = selectedPlaylists.filter(isPlaylistDeletable);
  if (deletable.length === 0) return;
  const removedIds = new Set<string>();
  for (const pl of deletable) {
    try {
      await deletePlaylist(pl.id);
      removeId(pl.id);
      removedIds.add(pl.id);
    } catch {
      showToast(t('playlists.deleteFailed', { name: pl.name }), 3000, 'error');
    }
  }
  if (removedIds.size > 0) {
    usePlaylistStore.setState((s) => ({
      playlists: s.playlists.filter((p) => !removedIds.has(p.id)),
    }));
    showToast(t('playlists.deleteSuccess', { count: removedIds.size }), 3000, 'info');
  }
  clearSelection();
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
    const sourceIds = selectedPlaylists
      .filter(pl => pl.id !== targetPlaylist.id)
      .map(pl => pl.id);
    const idsToAdd = await collectMergeSongIds(targetPlaylist.id, sourceIds);

    if (idsToAdd.length > 0) {
      await addSongsToPlaylist(targetPlaylist.id, idsToAdd);
      usePlaylistMembershipStore.getState().appendPlaylistSongIds(targetPlaylist.id, idsToAdd);
      touchPlaylist(targetPlaylist.id);
      showToast(t('playlists.mergeSuccess', { count: idsToAdd.length, playlist: targetPlaylist.name }), 3000, 'info');
    } else {
      showToast(t('playlists.mergeNoNewSongs'), 3000, 'info');
    }
    clearSelection();
  } catch {
    usePlaylistMembershipStore.getState().invalidatePlaylistSongIds(targetPlaylist.id);
    showToast(t('playlists.mergeError'), 4000, 'error');
  }
}
