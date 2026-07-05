import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { libraryIsReady } from '@/lib/library/libraryReady';

/**
 * Timeline cold bootstrap reads local `play_session` (cross-server). Gate on at
 * least one indexed profile being ready so JOIN metadata is trustworthy; when no
 * servers are configured, allow fetch immediately.
 */
export async function timelineBootstrapIndexReady(): Promise<boolean> {
  const servers = useAuthStore.getState().servers;
  if (servers.length === 0) return true;

  const indexed = useLibraryIndexStore
    .getState()
    .indexedServerIds(servers.map(s => s.id));
  if (indexed.length === 0) return true;

  for (const serverId of indexed) {
    if (await libraryIsReady(serverId)) return true;
  }
  return false;
}
