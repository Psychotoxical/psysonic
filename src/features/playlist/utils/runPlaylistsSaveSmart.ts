import type React from 'react';
import type { TFunction } from 'i18next';
import { ndCreateSmartPlaylist, ndGetSmartPlaylist, ndUpdateSmartPlaylist } from '@/lib/api/navidromeSmart';
import { getPlaylistForServer } from '@/lib/api/subsonicPlaylists';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { usePlaylistStore } from '@/features/playlist/store/playlistStore';
import {
  defaultSmartFilters,
  type PendingSmartPlaylist, type SmartFilters,
} from '@/features/playlist/utils/playlistsSmart';
import {
  comparePersistedSmartRules,
  createSmartEditorSession,
  hasEmptySmartCriteria,
  type SmartEditorSession,
} from '@/features/playlist/utils/smartPlaylistEditor';
import { emitSmartRulesDocument } from '@/features/playlist/utils/smartPlaylistRules';
import { showToast } from '@/lib/dom/toast';
import { resolvePlaylistPersistedName } from '@/features/playlist/utils/playlistOwnedMutation';
import { usePlaylistMembershipStore } from '@/store/playlistMembershipStore';

export interface RunPlaylistsSaveSmartDeps {
  isNavidromeServer: boolean;
  serverId: string;
  smartFilters: SmartFilters;
  smartSession: SmartEditorSession;
  allGenres: string[];
  editingSmartId: string | null;
  playlists: SubsonicPlaylist[];
  fetchPlaylists: () => Promise<void>;
  t: TFunction;
  ownerUsername?: string;
  saveAsCopy?: boolean;
  setPendingSmart: React.Dispatch<React.SetStateAction<PendingSmartPlaylist[]>>;
  setCreatingSmart: React.Dispatch<React.SetStateAction<boolean>>;
  setEditingSmartId: React.Dispatch<React.SetStateAction<string | null>>;
  setSmartFilters: React.Dispatch<React.SetStateAction<SmartFilters>>;
  setSmartSession: React.Dispatch<React.SetStateAction<SmartEditorSession>>;
  setGenreQuery: React.Dispatch<React.SetStateAction<string>>;
  setCreatingSmartBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setEditingSmartServerId: React.Dispatch<React.SetStateAction<string | null>>;
  isCurrent?: () => boolean;
}

function uniquePlaylistName(requested: string, playlists: SubsonicPlaylist[], serverId: string): string {
  const existingNames = new Set(
    playlists
      .filter(playlist => playlist.serverId === serverId)
      .map(playlist => (playlist.name ?? '').toLowerCase()),
  );
  if (!existingNames.has(requested.toLowerCase())) return requested;
  let ordinal = 2;
  let candidate = `${requested}-${ordinal}`;
  while (existingNames.has(candidate.toLowerCase())) {
    ordinal += 1;
    candidate = `${requested}-${ordinal}`;
  }
  return candidate;
}

async function hydrateFirstPageTracks(serverId: string, playlistId: string): Promise<void> {
  try {
    const { playlist, songs } = await getPlaylistForServer(serverId, playlistId);
    usePlaylistMembershipStore.getState().setPlaylistSongIds(
      playlistId,
      songs.map(song => song.id),
      serverId,
    );
    usePlaylistStore.setState(state => ({
      playlists: state.playlists.map(item => (
        item.serverId === serverId && item.id === playlistId
          ? { ...item, ...playlist, serverId, songCount: songs.length || playlist.songCount }
          : item
      )),
    }));
  } catch {
    // Keep the list row even if the first-page read is still empty.
  }
}

export async function runPlaylistsSaveSmart(deps: RunPlaylistsSaveSmartDeps): Promise<void> {
  const {
    isNavidromeServer, serverId, smartFilters, smartSession, editingSmartId, playlists, fetchPlaylists, t,
    ownerUsername, saveAsCopy,
    setPendingSmart, setCreatingSmart, setEditingSmartId, setSmartFilters, setSmartSession,
    setGenreQuery, setCreatingSmartBusy, setEditingSmartServerId,
  } = deps;

  if (!isNavidromeServer) {
    showToast(t('smartPlaylists.navidromeOnly'), 3500, 'error');
    return;
  }
  if (hasEmptySmartCriteria(smartSession.document)) {
    showToast(t('smartPlaylists.emptyCriteria'), 3500, 'error');
    return;
  }
  setCreatingSmartBusy(true);
  try {
    const requestedName = smartFilters.name.trim() || `mix-${new Date().toISOString().slice(0, 10)}`;
    const updating = Boolean(editingSmartId) && !saveAsCopy;
    const existing = updating
      ? playlists.find(playlist => playlist.id === editingSmartId && playlist.serverId === serverId)
      : undefined;
    const name = updating
      ? (existing ? resolvePlaylistPersistedName(existing, requestedName) : requestedName)
      : uniquePlaylistName(requestedName, playlists, serverId);
    const rules = emitSmartRulesDocument(smartSession.document);
    const writeOptions = {
      serverId,
      comment: smartSession.comment,
      public: smartSession.public,
      owner: smartSession.owner || ownerUsername,
    };
    const saved = updating && editingSmartId
      ? await ndUpdateSmartPlaylist(editingSmartId, name, rules, writeOptions)
      : await ndCreateSmartPlaylist(name, rules, writeOptions);
    if (deps.isCurrent && !deps.isCurrent()) return;
    const savedId = saved.id || editingSmartId || undefined;
    if (savedId) {
      try {
        const persisted = await ndGetSmartPlaylist(savedId, serverId);
        const dropped = comparePersistedSmartRules(rules, persisted.rules);
        if (dropped.length > 0) {
          showToast(t('smartPlaylists.droppedClauses'), 4500, 'warning');
        }
      } catch {
        // Comparison is best-effort; the playlist was already written.
      }
    }
    await fetchPlaylists();
    if (deps.isCurrent && !deps.isCurrent()) return;
    if (savedId) await hydrateFirstPageTracks(serverId, savedId);
    if (deps.isCurrent && !deps.isCurrent()) return;
    const createdName = name;
    const updatedId = updating ? editingSmartId : savedId ?? null;
    setPendingSmart(prev => {
      const existing = prev.find(p => p.serverId === serverId && (p.id === updatedId || p.name === createdName));
      if (existing) return prev;
      const created = usePlaylistStore.getState().playlists.find(
        p => p.serverId === serverId && (p.id === updatedId || p.name === createdName),
      );
      return [
        ...prev,
        {
          name: createdName,
          serverId,
          id: updatedId ?? created?.id,
          firstSeenCoverArt: created?.coverArt,
          attempts: 0,
        },
      ];
    });
    setCreatingSmart(false);
    setEditingSmartId(null);
    setEditingSmartServerId(null);
    setSmartFilters(defaultSmartFilters);
    setSmartSession(createSmartEditorSession());
    setGenreQuery('');
    if (updating) showToast(t('smartPlaylists.updated', { name: createdName }), 3500, 'success');
    else showToast(t('smartPlaylists.created', { name: createdName }), 3500, 'success');
  } catch {
    if (!deps.isCurrent || deps.isCurrent()) {
      showToast(editingSmartId && !saveAsCopy ? t('smartPlaylists.updateFailed') : t('smartPlaylists.createFailed'), 3500, 'error');
    }
  } finally {
    if (!deps.isCurrent || deps.isCurrent()) setCreatingSmartBusy(false);
  }
}
