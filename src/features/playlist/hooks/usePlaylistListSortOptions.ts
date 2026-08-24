import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PLAYLIST_LIST_SORT_KEYS,
  type PlaylistListSortKey,
} from '@/features/playlist/utils/playlistListSort';

export interface PlaylistListSortOption {
  value: PlaylistListSortKey;
  label: string;
}

const LABEL_KEY: Record<PlaylistListSortKey, string> = {
  name: 'playlists.listSort.name',
  created: 'playlists.listSort.created',
  songCount: 'playlists.listSort.songCount',
};

/**
 * Translated sort options for the playlist list.
 *
 * Shared so the sidebar section and the Playlists page offer the same choices
 * in the same order — they drive one persisted setting, and two lists that
 * drifted apart would make that setting look broken.
 */
export function usePlaylistListSortOptions(): PlaylistListSortOption[] {
  const { t } = useTranslation();
  return useMemo(
    () => PLAYLIST_LIST_SORT_KEYS.map(value => ({ value, label: t(LABEL_KEY[value]) })),
    [t],
  );
}
