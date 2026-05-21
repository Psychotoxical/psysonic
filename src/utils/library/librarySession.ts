import {
  libraryGetStatus,
  librarySyncBindSession,
} from '../../api/library';
import { enqueueLibrarySync, queueInitialSyncIfNeeded } from './librarySyncQueue';
import { pingWithCredentials } from '../../api/subsonic';
import type { ServerProfile } from '../../store/authStoreTypes';
import { useAuthStore } from '../../store/authStore';
import { useLibraryIndexStore } from '../../store/libraryIndexStore';
import { serverProfileBaseUrl } from '../server/serverBaseUrl';
import { libraryDevEnabled, logLibraryStatus, logLibrarySync, timed } from './libraryDevLog';

export type BindServerResult = 'bound' | 'offline' | 'error';

/**
 * Bind one server when it participates in the local index (master on, not excluded).
 */
export async function bindIndexedServer(server: ServerProfile): Promise<BindServerResult> {
  if (!useLibraryIndexStore.getState().isIndexEnabled(server.id)) return 'error';
  const baseUrl = serverProfileBaseUrl(server);
  if (!baseUrl) return 'error';

  try {
    const ping = await pingWithCredentials(server.url, server.username, server.password);
    if (!ping.ok) return 'offline';
  } catch {
    return 'offline';
  }

  try {
    const t0 = performance.now();
    await librarySyncBindSession({
      serverId: server.id,
      baseUrl,
      username: server.username,
      password: server.password,
    });
    if (libraryDevEnabled()) {
      const { result: status, ms } = await timed(() => libraryGetStatus(server.id));
      logLibrarySync({
        at: new Date().toISOString(),
        kind: 'bind_session',
        serverId: server.id,
        ingestStrategy: status.ingestStrategy ?? null,
        ingestPhase: status.ingestPhase ?? null,
        syncPhase: status.syncPhase,
        n1BulkUnreliable: status.n1BulkUnreliable ?? null,
        durationMs: Math.round(performance.now() - t0),
        message: `status fetch ${ms}ms`,
      });
      logLibraryStatus(server.id, status, 'bind_session');
    }
    return 'bound';
  } catch {
    return 'error';
  }
}

/** Bind + kick off initial sync for one indexed server. */
export async function bootstrapIndexedServer(server: ServerProfile): Promise<BindServerResult> {
  const bound = await bindIndexedServer(server);
  if (bound !== 'bound') return bound;
  await queueInitialSyncIfNeeded(server.id);
  return 'bound';
}

/** Bind all indexed servers, then queue initial syncs one server at a time. */
export async function bootstrapAllIndexedServers(): Promise<Record<string, BindServerResult>> {
  const lib = useLibraryIndexStore.getState();
  if (!lib.masterEnabled) return {};
  const indexed = useAuthStore.getState().servers.filter(s => lib.isIndexEnabled(s.id));
  const results: Record<string, BindServerResult> = {};
  for (const server of indexed) {
    results[server.id] = await bindIndexedServer(server);
  }
  for (const server of indexed) {
    if (results[server.id] === 'bound') {
      await queueInitialSyncIfNeeded(server.id);
    }
  }
  return results;
}

/**
 * Re-bind the active server when indexed (legacy entry point for startup hooks).
 */
export async function ensureActiveServerSessionBound(): Promise<boolean> {
  const auth = useAuthStore.getState();
  const server = auth.servers.find(s => s.id === auth.activeServerId);
  if (!server) return false;
  if (!useLibraryIndexStore.getState().isIndexEnabled(server.id)) return false;
  return (await bindIndexedServer(server)) === 'bound';
}

const resumeInFlight = new Set<string>();

export async function resumeInitialSyncIfIncomplete(serverId: string): Promise<void> {
  if (resumeInFlight.has(serverId)) return;
  resumeInFlight.add(serverId);
  try {
    const { result: status, ms: statusMs } = await timed(() => libraryGetStatus(serverId));
    if (status.syncPhase === 'ready' || status.lastFullSyncAt) return;
    if (status.syncPhase !== 'initial_sync') return;
    const resumeT0 = performance.now();
    await enqueueLibrarySync({ serverId, kind: 'full' });
    if (libraryDevEnabled()) {
      logLibrarySync({
        at: new Date().toISOString(),
        kind: 'resume_initial_sync',
        serverId,
        ingestStrategy: status.ingestStrategy ?? null,
        ingestPhase: status.ingestPhase ?? null,
        syncPhase: status.syncPhase,
        n1BulkUnreliable: status.n1BulkUnreliable ?? null,
        localTrackCount: status.localTrackCount ?? null,
        serverTrackCount: status.serverTrackCount ?? null,
        durationMs: Math.round(performance.now() - resumeT0),
        message: `status ${statusMs}ms`,
      });
      logLibraryStatus(serverId, status, 'resume_initial_sync');
    }
  } catch {
    /* best-effort */
  } finally {
    resumeInFlight.delete(serverId);
  }
}
