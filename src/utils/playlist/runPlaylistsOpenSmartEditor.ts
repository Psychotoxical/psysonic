import type React from 'react';
import type { TFunction } from 'i18next';
import { ndGetSmartPlaylist, ndListSmartPlaylists } from '../../api/navidromeSmart';
import type { SubsonicPlaylist } from '../../api/subsonicTypes';
import {
  defaultSmartFilters, displayPlaylistName, isSmartPlaylistName,
  parseSmartRulesToFilters, type SmartFilters,
} from './playlistsSmart';
import { showToast } from '../ui/toast';

export interface RunPlaylistsOpenSmartEditorDeps {
  pl: SubsonicPlaylist;
  isNavidromeServer: boolean;
  t: TFunction;
  setSmartFilters: React.Dispatch<React.SetStateAction<SmartFilters>>;
  setEditingSmartId: React.Dispatch<React.SetStateAction<string | null>>;
  setGenreQuery: React.Dispatch<React.SetStateAction<string>>;
  setCreating: React.Dispatch<React.SetStateAction<boolean>>;
  setCreatingSmart: React.Dispatch<React.SetStateAction<boolean>>;
  setCreatingSmartBusy: React.Dispatch<React.SetStateAction<boolean>>;
}

export async function runPlaylistsOpenSmartEditor(deps: RunPlaylistsOpenSmartEditorDeps): Promise<void> {
  const {
    pl, isNavidromeServer, t,
    setSmartFilters, setEditingSmartId, setGenreQuery,
    setCreating, setCreatingSmart, setCreatingSmartBusy,
  } = deps;

  if (!isNavidromeServer || !isSmartPlaylistName(pl.name)) return;
  setCreatingSmartBusy(true);
  try {
    let target: { id: string; name: string; rules?: Record<string, unknown> } | null = null;
    try {
      // Prefer direct endpoint for this playlist: returns freshest rules.
      const direct = await ndGetSmartPlaylist(pl.id);
      if (direct.id && (direct.rules || isSmartPlaylistName(direct.name))) target = direct;
    } catch {
      // Fallback to list endpoint below.
    }
    if (!target) {
      const smart = await ndListSmartPlaylists();
      target = smart.find((v) =>
        v.id === pl.id ||
        v.name === pl.name ||
        displayPlaylistName(v.name) === displayPlaylistName(pl.name),
      ) ?? null;
    }
    if (target) {
      setSmartFilters(parseSmartRulesToFilters(target.rules, target.name));
      setEditingSmartId(target.id);
    } else {
      // Fallback: allow editing even if Navidrome smart list endpoint
      // doesn't return this playlist (shared/migrated/legacy edge cases).
      setSmartFilters({
        ...defaultSmartFilters,
        name: displayPlaylistName(pl.name),
      });
      setEditingSmartId(pl.id);
    }
    setGenreQuery('');
    setCreating(false);
    setCreatingSmart(true);
  } catch {
    // Degrade gracefully instead of blocking the editor on transient/API errors.
    setSmartFilters({
      ...defaultSmartFilters,
      name: displayPlaylistName(pl.name),
    });
    setGenreQuery('');
    setEditingSmartId(pl.id);
    setCreating(false);
    setCreatingSmart(true);
    showToast(t('smartPlaylists.loadFailed'), 3500, 'warning');
  } finally {
    setCreatingSmartBusy(false);
  }
}
