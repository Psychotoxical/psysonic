import type { TFunction } from 'i18next';
import { getPlaylist, updatePlaylistMeta, uploadPlaylistCoverArt } from '../api/subsonicPlaylists';
import type { SubsonicPlaylist } from '../api/subsonicTypes';
import { showToast } from './toast';

export interface RunPlaylistSaveMetaDeps {
  id: string;
  playlist: SubsonicPlaylist;
  t: TFunction;
  setPlaylist: (updater: (p: SubsonicPlaylist | null) => SubsonicPlaylist | null) => void;
  setCustomCoverId: (id: string | null) => void;
  setEditingMeta: (v: boolean) => void;
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
  const { id, playlist, t, setPlaylist, setCustomCoverId, setEditingMeta } = deps;
  await updatePlaylistMeta(id, opts.name.trim() || playlist.name, opts.comment, opts.isPublic);
  setPlaylist(p => p
    ? { ...p, name: opts.name.trim() || p.name, comment: opts.comment, public: opts.isPublic }
    : p
  );
  if (opts.coverFile) {
    try {
      await uploadPlaylistCoverArt(id, opts.coverFile);
      const { playlist: refreshed } = await getPlaylist(id);
      setPlaylist(prev => prev ? { ...prev, coverArt: refreshed.coverArt } : prev);
      if (refreshed.coverArt) setCustomCoverId(refreshed.coverArt);
      showToast(t('playlists.coverUpdated'));
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('playlists.coverUpdated'), 3000, 'error');
    }
  } else if (opts.coverRemoved) {
    setCustomCoverId(null);
  }
  showToast(t('playlists.metaSaved'));
  setEditingMeta(false);
}
