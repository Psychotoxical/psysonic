import { deletePlaylist } from '@/lib/api/subsonicPlaylists';
import { ndDeletePlaylist } from '@/lib/api/navidromeSmart';
import type { SubsonicPlaylist } from '@/lib/api/subsonicTypes';
import { isSmartPlaylist, playlistDisplayName } from '@/lib/format/playlistClassification';

export const OPEN_SMART_EDITOR_STATE_KEY = 'openSmartEditorFor';

export type OpenSmartEditorIntent = {
  id: string;
  serverId: string;
  name?: string;
};

/** Persist the stored name unless the user explicitly changed the visible title. */
export function resolvePlaylistPersistedName(
  playlist: Pick<SubsonicPlaylist, 'name'>,
  enteredName: string,
): string {
  const trimmed = enteredName.trim();
  const visible = playlistDisplayName(playlist);
  if (!trimmed || trimmed === visible) return playlist.name;
  return trimmed;
}

export function shouldUseNativePlaylistMutation(playlist: Pick<SubsonicPlaylist, 'name'> & Pick<Partial<SubsonicPlaylist>, 'smart'>): boolean {
  return isSmartPlaylist(playlist);
}

export async function deleteOwnedPlaylist(
  playlist: Pick<SubsonicPlaylist, 'id' | 'name'> & Pick<Partial<SubsonicPlaylist>, 'serverId' | 'smart'>,
): Promise<void> {
  if (!playlist.serverId) throw new Error('Playlist owner unavailable');
  if (shouldUseNativePlaylistMutation(playlist)) {
    await ndDeletePlaylist(playlist.id, playlist.serverId);
    return;
  }
  await deletePlaylist(playlist.id, playlist.serverId);
}

export function playlistsOpenSmartEditorState(playlist: Pick<SubsonicPlaylist, 'id' | 'name'> & Pick<Partial<SubsonicPlaylist>, 'serverId'>): {
  pathname: string;
  state: { [OPEN_SMART_EDITOR_STATE_KEY]: OpenSmartEditorIntent };
} | null {
  if (!playlist.serverId) return null;
  return {
    pathname: '/playlists',
    state: {
      [OPEN_SMART_EDITOR_STATE_KEY]: {
        id: playlist.id,
        serverId: playlist.serverId,
        name: playlist.name,
      },
    },
  };
}

export function playlistStubFromOpenSmartEditorIntent(intent: OpenSmartEditorIntent): SubsonicPlaylist {
  return {
    id: intent.id,
    serverId: intent.serverId,
    name: intent.name ?? '',
    smart: true,
    songCount: 0,
    duration: 0,
    created: '',
    changed: '',
  };
}

export function readOpenSmartEditorIntent(state: unknown): OpenSmartEditorIntent | null {
  if (!state || typeof state !== 'object') return null;
  const raw = (state as Record<string, unknown>)[OPEN_SMART_EDITOR_STATE_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.id !== 'string' || !rec.id || typeof rec.serverId !== 'string' || !rec.serverId) {
    return null;
  }
  return {
    id: rec.id,
    serverId: rec.serverId,
    ...(typeof rec.name === 'string' ? { name: rec.name } : {}),
  };
}
