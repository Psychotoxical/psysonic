import type { TFunction } from 'i18next';
import { ndUpdatePlaylistMeta } from '@/lib/api/navidromeSmart';
import { getPlaylist, getPlaylistForServer, updatePlaylistMeta, uploadPlaylistCoverArt } from '@/lib/api/subsonicPlaylists';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { showToast } from '@/lib/dom/toast';
import {
  resolvePlaylistPersistedName,
  shouldUseNativePlaylistMutation,
} from '@/features/playlist/utils/playlistOwnedMutation';

export interface RunPlaylistSaveMetaDeps {
  id: string;
  serverId?: string;
  playlist: SubsonicPlaylist;
  t: TFunction;
  setPlaylist: (updater: (p: SubsonicPlaylist | null) => SubsonicPlaylist | null) => void;
  setCustomCoverId: (id: string | null) => void;
  setEditingMeta: (v: boolean) => void;
  isCurrent?: () => boolean;
}

export async function runPlaylistSaveMeta(
  deps: RunPlaylistSaveMetaDeps,
  opts: {
    name: string;
    comment: string;
    isPublic: boolean;
    coverFile: File | null;
    coverRemoved: boolean;
  },
): Promise<void> {
  const { id, serverId, playlist, t, setPlaylist, setCustomCoverId, setEditingMeta } = deps;
  const nextName = resolvePlaylistPersistedName(playlist, opts.name);
  if (shouldUseNativePlaylistMutation(playlist)) {
    await ndUpdatePlaylistMeta(id, {
      name: nextName,
      comment: opts.comment,
      public: opts.isPublic,
    }, serverId);
  } else {
    await updatePlaylistMeta(id, nextName, opts.comment, opts.isPublic, serverId);
  }
  if (!deps.isCurrent || deps.isCurrent()) {
    setPlaylist(p => p
      ? { ...p, name: nextName, comment: opts.comment, public: opts.isPublic }
      : p
    );
  }
  if (opts.coverFile) {
    try {
      await uploadPlaylistCoverArt(id, opts.coverFile, serverId);
      const { playlist: refreshed } = serverId
        ? await getPlaylistForServer(serverId, id)
        : await getPlaylist(id);
      if (!deps.isCurrent || deps.isCurrent()) {
        setPlaylist(prev => prev ? { ...prev, coverArt: refreshed.coverArt } : prev);
        if (refreshed.coverArt) setCustomCoverId(refreshed.coverArt);
        showToast(t('playlists.coverUpdated'));
      }
    } catch (err) {
      if (!deps.isCurrent || deps.isCurrent()) {
        showToast(err instanceof Error ? err.message : t('playlists.coverUpdated'), 3000, 'error');
      }
    }
  } else if (opts.coverRemoved) {
    if (!deps.isCurrent || deps.isCurrent()) setCustomCoverId(null);
  }
  if (!deps.isCurrent || deps.isCurrent()) {
    showToast(t('playlists.metaSaved'));
    setEditingMeta(false);
  }
}
