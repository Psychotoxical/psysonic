import type React from 'react';
import type { TFunction } from 'i18next';
import { addSongsToPlaylist } from '@/lib/api/subsonicPlaylists';
import { deleteOwnedPlaylist } from '@/features/playlist/utils/playlistOwnedMutation';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { usePlaylistStore } from '@/features/playlist/store/playlistStore';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';
import { collectMergeSongIds } from '@/features/playlist/utils/addTracksToPlaylistWithDedup';
import { showToast } from '@/lib/dom/toast';
import { ownedEntityKey } from '@/lib/util/ownedEntityKey';

export interface RunPlaylistDeleteDeps {
  e: React.MouseEvent;
  pl: SubsonicPlaylist;
  deleteConfirmId: string | null;
  setDeleteConfirmId: React.Dispatch<React.SetStateAction<string | null>>;
  removeId: (id: string, serverId?: string) => void;
  t: TFunction;
}

export async function runPlaylistDelete(deps: RunPlaylistDeleteDeps): Promise<void> {
  const { e, pl, deleteConfirmId, setDeleteConfirmId, removeId, t } = deps;
  e.stopPropagation();
  const key = ownedEntityKey(pl);
  if (deleteConfirmId !== key) {
    setDeleteConfirmId(key);
    const btn = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => {
      btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    return;
  }
  try {
    if (!pl.serverId) throw new Error('Playlist owner unavailable');
    await deleteOwnedPlaylist(pl);
    removeId(pl.id, pl.serverId);
    usePlaylistStore.setState((s) => ({
      playlists: s.playlists.filter((p) => ownedEntityKey(p) !== key),
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
  removeId: (id: string, serverId?: string) => void;
  clearSelection: () => void;
  t: TFunction;
}

export async function runPlaylistDeleteSelected(deps: RunPlaylistDeleteSelectedDeps): Promise<void> {
  const { selectedPlaylists, isPlaylistDeletable, removeId, clearSelection, t } = deps;
  const deletable = selectedPlaylists.filter(isPlaylistDeletable);
  if (deletable.length === 0) return;
  const removedKeys = new Set<string>();
  for (const pl of deletable) {
    try {
      if (!pl.serverId) throw new Error('Playlist owner unavailable');
      await deleteOwnedPlaylist(pl);
      removeId(pl.id, pl.serverId);
      removedKeys.add(ownedEntityKey(pl));
    } catch {
      showToast(t('playlists.deleteFailed', { name: pl.name }), 3000, 'error');
    }
  }
  if (removedKeys.size > 0) {
    usePlaylistStore.setState((s) => ({
      playlists: s.playlists.filter((p) => !removedKeys.has(ownedEntityKey(p))),
    }));
    showToast(t('playlists.deleteSuccess', { count: removedKeys.size }), 3000, 'info');
  }
  clearSelection();
}

export interface RunPlaylistMergeSelectedDeps {
  targetPlaylist: SubsonicPlaylist;
  selectedPlaylists: SubsonicPlaylist[];
  touchPlaylist: (id: string, serverId?: string) => void;
  clearSelection: () => void;
  t: TFunction;
}

export async function runPlaylistMergeSelected(deps: RunPlaylistMergeSelectedDeps): Promise<void> {
  const { targetPlaylist, selectedPlaylists, touchPlaylist, clearSelection, t } = deps;
  if (selectedPlaylists.length === 0) return;
  try {
    const serverId = targetPlaylist.serverId;
    if (!serverId) throw new Error('Playlist owner unavailable');
    const sourceIds = selectedPlaylists
      .filter(pl => pl.serverId === serverId && ownedEntityKey(pl) !== ownedEntityKey(targetPlaylist))
      .map(pl => pl.id);
    const idsToAdd = await collectMergeSongIds(targetPlaylist.id, sourceIds, serverId);

    if (idsToAdd.length > 0) {
      await addSongsToPlaylist(targetPlaylist.id, idsToAdd, serverId);
      usePlaylistMembershipStore.getState().appendPlaylistSongIds(targetPlaylist.id, idsToAdd, serverId);
      touchPlaylist(targetPlaylist.id, serverId);
      showToast(t('playlists.mergeSuccess', { count: idsToAdd.length, playlist: targetPlaylist.name }), 3000, 'info');
    } else {
      showToast(t('playlists.mergeNoNewSongs'), 3000, 'info');
    }
    clearSelection();
  } catch {
    usePlaylistMembershipStore.getState().invalidatePlaylistSongIds(targetPlaylist.id, targetPlaylist.serverId);
    showToast(t('playlists.mergeError'), 4000, 'error');
  }
}
