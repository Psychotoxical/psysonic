import { useAuthStore } from '@/store/authStore';

type SuspendSnapshot = {
  selection: Record<string, string[]>;
  legacy: Record<string, 'all' | string>;
};

let saved: SuspendSnapshot | null = null;

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Resolve the effective ordered selection for a server from a snapshot, mirroring
 * `librarySelectionForServer`: an explicit selection wins; otherwise fall back to
 * the legacy single-folder field (`'all'`/absent → browse all).
 */
function effectiveSelection(snapshot: SuspendSnapshot, serverId: string): string[] {
  const selection = snapshot.selection[serverId];
  if (selection !== undefined) return selection;
  const legacy = snapshot.legacy[serverId];
  if (legacy === undefined || legacy === 'all') return [];
  return [legacy];
}

/** Remember the sidebar library selection and browse all libraries while offline. */
export function suspendMusicLibraryFiltersForOffline(): void {
  if (saved != null) return;
  const auth = useAuthStore.getState();
  saved = {
    selection: { ...auth.musicLibrarySelectionByServer },
    legacy: { ...auth.musicLibraryFilterByServer },
  };
  const serverId = auth.activeServerId;
  if (!serverId) return;
  // Readers prefer the ordered selection, so forcing "all" must clear the
  // selection (not just the legacy field) — otherwise a user who narrowed via
  // the picker stays scoped to libraries that may be unavailable offline.
  if (effectiveSelection(saved, serverId).length > 0) {
    auth.setMusicLibrarySelection([]);
  }
}

/** Restore the pre-offline library selection for the active server. */
export function restoreMusicLibraryFiltersAfterOffline(): void {
  if (!saved) return;
  const snapshot = saved;
  saved = null;
  const auth = useAuthStore.getState();
  const serverId = auth.activeServerId;
  if (!serverId) return;
  const target = effectiveSelection(snapshot, serverId);
  const current = auth.musicLibrarySelectionByServer[serverId] ?? [];
  if (!sameIds(target, current)) {
    auth.setMusicLibrarySelection(target);
  }
}

/** Test helper — drop suspended snapshot without restoring. */
export function resetOfflineLibraryFilterSuspendState(): void {
  saved = null;
}
