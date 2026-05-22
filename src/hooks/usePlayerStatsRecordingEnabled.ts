import { useAuthStore } from '../store/authStore';
import { useLibraryIndexStore } from '../store/libraryIndexStore';

/** True when local play history is recorded (master index on + ≥1 server included). */
export function usePlayerStatsRecordingEnabled(): boolean {
  const servers = useAuthStore(s => s.servers);
  const masterEnabled = useLibraryIndexStore(s => s.masterEnabled);
  const syncExcludedByServer = useLibraryIndexStore(s => s.syncExcludedByServer);
  return masterEnabled && servers.some(s => syncExcludedByServer[s.id] !== true);
}
