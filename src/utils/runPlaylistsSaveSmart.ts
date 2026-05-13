import type React from 'react';
import type { TFunction } from 'i18next';
import { ndCreateSmartPlaylist, ndUpdateSmartPlaylist } from '../api/navidromeSmart';
import type { SubsonicPlaylist } from '../api/subsonicTypes';
import { usePlaylistStore } from '../store/playlistStore';
import {
  buildSmartRulesPayload, defaultSmartFilters, SMART_PREFIX,
  type PendingSmartPlaylist, type SmartFilters,
} from './playlistsSmart';
import { showToast } from './toast';

export interface RunPlaylistsSaveSmartDeps {
  isNavidromeServer: boolean;
  smartFilters: SmartFilters;
  editingSmartId: string | null;
  playlists: SubsonicPlaylist[];
  fetchPlaylists: () => Promise<void>;
  t: TFunction;
  setPendingSmart: React.Dispatch<React.SetStateAction<PendingSmartPlaylist[]>>;
  setCreatingSmart: React.Dispatch<React.SetStateAction<boolean>>;
  setEditingSmartId: React.Dispatch<React.SetStateAction<string | null>>;
  setSmartFilters: React.Dispatch<React.SetStateAction<SmartFilters>>;
  setGenreQuery: React.Dispatch<React.SetStateAction<string>>;
  setCreatingSmartBusy: React.Dispatch<React.SetStateAction<boolean>>;
}

export async function runPlaylistsSaveSmart(deps: RunPlaylistsSaveSmartDeps): Promise<void> {
  const {
    isNavidromeServer, smartFilters, editingSmartId, playlists, fetchPlaylists, t,
    setPendingSmart, setCreatingSmart, setEditingSmartId, setSmartFilters,
    setGenreQuery, setCreatingSmartBusy,
  } = deps;

  if (!isNavidromeServer) {
    showToast(t('smartPlaylists.navidromeOnly'), 3500, 'error');
    return;
  }
  setCreatingSmartBusy(true);
  try {
    let baseName = smartFilters.name.trim() || `mix-${new Date().toISOString().slice(0, 10)}`;
    if (!editingSmartId) {
      const existingNames = new Set(playlists.map((p) => (p.name ?? '').toLowerCase()));
      const requestedBaseName = baseName;
      let ordinal = 2;
      while (existingNames.has(`${SMART_PREFIX}${baseName}`.toLowerCase())) {
        baseName = `${requestedBaseName}-${ordinal}`;
        ordinal += 1;
      }
    }
    const rules = buildSmartRulesPayload(smartFilters);
    const fullName = `${SMART_PREFIX}${baseName}`;
    if (editingSmartId) {
      await ndUpdateSmartPlaylist(editingSmartId, fullName, rules, true);
    } else {
      await ndCreateSmartPlaylist(fullName, rules, true);
    }
    await fetchPlaylists();
    const createdName = fullName;
    const updatedId = editingSmartId;
    setPendingSmart(prev => {
      const existing = prev.find(p => p.id === updatedId || p.name === createdName);
      if (existing) return prev;
      const created = usePlaylistStore.getState().playlists.find((p) => p.id === updatedId || p.name === createdName);
      return [
        ...prev,
        {
          name: createdName,
          id: updatedId ?? created?.id,
          firstSeenCoverArt: created?.coverArt,
          attempts: 0,
        },
      ];
    });
    setCreatingSmart(false);
    setEditingSmartId(null);
    setSmartFilters(defaultSmartFilters);
    setGenreQuery('');
    if (updatedId) showToast(t('smartPlaylists.updated', { name: createdName }), 3500, 'success');
    else showToast(t('smartPlaylists.created', { name: createdName }), 3500, 'success');
  } catch {
    showToast(editingSmartId ? t('smartPlaylists.updateFailed') : t('smartPlaylists.createFailed'), 3500, 'error');
  } finally {
    setCreatingSmartBusy(false);
  }
}
