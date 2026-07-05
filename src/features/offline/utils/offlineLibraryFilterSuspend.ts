import { useAuthStore } from '@/store/authStore';

let savedFilterByServer: Record<string, 'all' | string> | null = null;

/** Remember sidebar library filters and browse all libraries while offline. */
export function suspendMusicLibraryFiltersForOffline(): void {
  if (savedFilterByServer != null) return;
  const auth = useAuthStore.getState();
  savedFilterByServer = { ...auth.musicLibraryFilterByServer };
  const serverId = auth.activeServerId;
  if (!serverId) return;
  const current = auth.musicLibraryFilterByServer[serverId] ?? 'all';
  if (current !== 'all') {
    auth.setMusicLibraryFilter('all');
  }
}

/** Restore the pre-offline library filter for the active server. */
export function restoreMusicLibraryFiltersAfterOffline(): void {
  if (!savedFilterByServer) return;
  const snapshot = savedFilterByServer;
  savedFilterByServer = null;
  const auth = useAuthStore.getState();
  const serverId = auth.activeServerId;
  if (!serverId) return;
  const saved = snapshot[serverId] ?? 'all';
  const current = auth.musicLibraryFilterByServer[serverId] ?? 'all';
  if (saved !== current) {
    auth.setMusicLibraryFilter(saved);
  }
}

/** Test helper — drop suspended snapshot without restoring. */
export function resetOfflineLibraryFilterSuspendState(): void {
  savedFilterByServer = null;
}
