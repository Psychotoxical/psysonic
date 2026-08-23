import type React from 'react';
import type { TFunction } from 'i18next';
import { ndGetSmartPlaylist, ndListPlaylists } from '@/lib/api/navidromeSmart';
import type { SubsonicGenre, SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { type SmartFilters } from '@/features/playlist/utils/playlistsSmart';
import {
  createSmartEditorSession,
  type SmartEditorSession,
} from '@/features/playlist/utils/smartPlaylistEditor';
import { showToast } from '@/lib/dom/toast';
import {
  hasNavidromeSmartRules,
  isSmartPlaylist,
  playlistDisplayName,
} from '@/lib/format/playlistClassification';

export interface RunPlaylistsOpenSmartEditorDeps {
  pl: SubsonicPlaylist;
  serverId: string;
  isNavidromeServer: boolean;
  allGenres: SubsonicGenre[];
  t: TFunction;
  setSmartFilters: React.Dispatch<React.SetStateAction<SmartFilters>>;
  setSmartSession: React.Dispatch<React.SetStateAction<SmartEditorSession>>;
  setEditingSmartId: React.Dispatch<React.SetStateAction<string | null>>;
  setGenreQuery: React.Dispatch<React.SetStateAction<string>>;
  setCreating: React.Dispatch<React.SetStateAction<boolean>>;
  setCreatingSmart: React.Dispatch<React.SetStateAction<boolean>>;
  setCreatingSmartBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setEditingSmartServerId: React.Dispatch<React.SetStateAction<string | null>>;
  isCurrent?: () => boolean;
}

function sessionFromNative(
  target: {
    name: string;
    rules?: Record<string, unknown>;
    comment?: string;
    public?: boolean;
    owner?: string;
    evaluatedAt?: string;
    updatedAt?: string;
  },
  allGenres: SubsonicGenre[],
): SmartEditorSession {
  return createSmartEditorSession({
    name: playlistDisplayName({ name: target.name }),
    rules: target.rules,
    comment: target.comment,
    public: target.public,
    owner: target.owner,
    evaluatedAt: target.evaluatedAt,
    updatedAt: target.updatedAt,
    allGenres: allGenres.map(genre => genre.value),
  });
}

export async function runPlaylistsOpenSmartEditor(deps: RunPlaylistsOpenSmartEditorDeps): Promise<void> {
  const {
    pl, serverId, isNavidromeServer, allGenres, t,
    setSmartFilters, setSmartSession, setEditingSmartId, setGenreQuery,
    setCreating, setCreatingSmart, setCreatingSmartBusy, setEditingSmartServerId,
  } = deps;

  if (!isNavidromeServer || !isSmartPlaylist(pl)) return;

  const placeholder = createSmartEditorSession({
    name: playlistDisplayName(pl),
    rules: { all: [] },
    comment: pl.comment,
    public: pl.public,
    owner: pl.owner,
  });
  setCreating(false);
  setCreatingSmart(true);
  setCreatingSmartBusy(true);
  setEditingSmartId(pl.id);
  setEditingSmartServerId(serverId);
  setGenreQuery('');
  setSmartSession(placeholder);
  setSmartFilters(placeholder.filters);

  const closeEditor = () => {
    setCreatingSmart(false);
    setEditingSmartId(null);
    setEditingSmartServerId(null);
  };

  try {
    let target: {
      id: string;
      name: string;
      rules?: Record<string, unknown>;
      comment?: string;
      public?: boolean;
      owner?: string;
      evaluatedAt?: string;
      updatedAt?: string;
    } | null = null;
    try {
      const direct = await ndGetSmartPlaylist(pl.id, serverId);
      if (direct.id) {
        if (!hasNavidromeSmartRules(direct.rules)) {
          if (deps.isCurrent && !deps.isCurrent()) return;
          closeEditor();
          return;
        }
        target = direct;
      }
    } catch {
      // Fallback to list endpoint below.
    }
    if (!target) {
      const smart = await ndListPlaylists(serverId);
      target = smart.find((v) =>
        hasNavidromeSmartRules(v.rules)
        && (
          v.id === pl.id
          || v.name === pl.name
          || playlistDisplayName(v) === playlistDisplayName(pl)
        ),
      ) ?? null;
      if (!target) {
        if (deps.isCurrent && !deps.isCurrent()) return;
        closeEditor();
        return;
      }
    }
    if (deps.isCurrent && !deps.isCurrent()) return;
    const session = sessionFromNative({
      ...target,
      comment: target.comment ?? pl.comment,
      public: target.public ?? pl.public,
      owner: target.owner ?? pl.owner,
    }, allGenres);
    setSmartSession(session);
    setSmartFilters(session.filters);
    setEditingSmartId(target.id);
    setEditingSmartServerId(serverId);
  } catch {
    if (deps.isCurrent && !deps.isCurrent()) return;
    const session = createSmartEditorSession({
      name: playlistDisplayName(pl),
      comment: pl.comment,
      public: pl.public,
      owner: pl.owner,
    });
    setSmartSession(session);
    setSmartFilters(session.filters);
    setGenreQuery('');
    setEditingSmartId(pl.id);
    setEditingSmartServerId(serverId);
    setCreating(false);
    setCreatingSmart(true);
    showToast(t('smartPlaylists.loadFailed'), 3500, 'warning');
  } finally {
    if (!deps.isCurrent || deps.isCurrent()) setCreatingSmartBusy(false);
  }
}
