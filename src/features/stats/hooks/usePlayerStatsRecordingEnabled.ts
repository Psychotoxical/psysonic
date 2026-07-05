import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';

/** True when local play history is recorded (master index on + ≥1 server included). */
export function usePlayerStatsRecordingEnabled(): boolean {
  const servers = useAuthStore(s => s.servers);
  const masterEnabled = useLibraryIndexStore(s => s.masterEnabled);
  const indexedServerIds = useLibraryIndexStore(s => s.indexedServerIds);
  return masterEnabled && indexedServerIds(servers.map(s => s.id)).length > 0;
}
