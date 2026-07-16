import {
  libraryGetStatus,
  librarySyncBindSession,
} from '@/lib/api/library';
import { enqueueLibrarySync, queueInitialSyncIfNeeded } from './librarySyncQueue';
import type { ServerProfile } from '@/store/authStoreTypes';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { ensureConnectUrlResolved } from '@/lib/server/serverEndpoint';
import {
  serverIndexKeyForProfile,
  serverIndexOwnerForKey,
  serverIndexOwners,
} from '@/lib/server/serverIndexKey';
import {
  syncAllServerHttpContexts,
  syncServerHttpContextForProfile,
} from '@/lib/server/syncServerHttpContext';
import {
  libraryCoverBackfillRunFullPass,
  libraryCoverClearFetchFailures,
} from '@/lib/api/coverCache';
import { libraryDevEnabled, logLibraryStatus, logLibrarySync, timed } from './libraryDevLog';

export type BindServerResult = 'bound' | 'offline' | 'error';

/**
 * A gated server (Cloudflare Access / Pangolin) whose cover fetches 403'd while
 * the native header registry was momentarily empty — e.g. a dev restart before
 * {@link syncServerHttpContextForProfile} landed — wrote 30-minute
 * `.fetch-failed` markers, so those covers won't retry on their own even after
 * the gate starts answering. Once the header is (re)registered we drop the
 * markers and kick a backfill pass so the covers re-download, mirroring the
 * URL-change retry in `library_cover_backfill_set_base_url`.
 */
async function retryGatedServerCovers(server: ServerProfile): Promise<void> {
  if (!server.customHeaders?.length) return;
  try {
    const cleared = await libraryCoverClearFetchFailures(serverIndexKeyForProfile(server));
    if (cleared > 0) void libraryCoverBackfillRunFullPass(true);
  } catch {
    /* best-effort — a missing cover cache or offline server is not fatal to bind */
  }
}

/**
 * Bind one server when it participates in the local index (master on, not excluded).
 */
export async function bindIndexedServer(server: ServerProfile): Promise<BindServerResult> {
  if (!useLibraryIndexStore.getState().isIndexEnabled(server.id)) return 'error';

  // Register per-server gate headers in the native registry FIRST — before the
  // reachability probe, the bind session, and any stream / cover / prefetch
  // request. Those native (reqwest) paths resolve their gate header from the
  // registry synchronously at call time, so the sync must COMPLETE (awaited)
  // before we probe/bind — a fire-and-forget sync let the native probe/bind
  // race an empty registry and 403 behind the gate. `bootstrapAllIndexedServers`
  // already syncs up front, but a direct `bindIndexedServer` (add / enable one
  // server) has only this call to lean on.
  await syncServerHttpContextForProfile(server).catch(() => {});
  // Header is registered now: clear any stale gate-403 `.fetch-failed` cover
  // markers so covers that failed during a registry gap re-download. Best-effort
  // and independent of bind — keep it off the critical path.
  void retryGatedServerCovers(server);

  // Dual-address: resolve the connect URL once (LAN-first, sticky cached) and
  // hand that to the Rust bind-session command — Rust then sees the reachable
  // endpoint instead of the literal primary URL. Single-address profiles fall
  // through to one ping, identical to the legacy path.
  const probe = await ensureConnectUrlResolved(server);
  if (!probe.ok) return 'offline';
  const baseUrl = probe.baseUrl;

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
  const indexKey = serverIndexKeyForProfile(server);
  await queueInitialSyncIfNeeded(indexKey);
  return 'bound';
}

/** Bind all indexed servers, then queue initial syncs one server at a time. */
export async function bootstrapAllIndexedServers(): Promise<Record<string, BindServerResult>> {
  const lib = useLibraryIndexStore.getState();
  if (!lib.masterEnabled) return {};
  const auth = useAuthStore.getState();
  // Authoritatively (re)populate the native gate-header registry for every saved
  // server before any bind/probe runs. The persist-rehydrate sync fires very
  // early and is best-effort; this runs once React has mounted and the Tauri IPC
  // bridge is ready, so a gated server's headers are present for the reachability
  // probe, stream, cover and prefetch paths that resolve them from the registry.
  const indexed = serverIndexOwners(auth).filter(server => lib.isIndexEnabled(server.id));
  await syncAllServerHttpContexts(indexed).catch(() => {});
  const results: Record<string, BindServerResult> = {};
  for (const server of indexed) {
    const key = serverIndexKeyForProfile(server);
    results[key] = await bindIndexedServer(server);
  }
  for (const server of indexed) {
    const key = serverIndexKeyForProfile(server);
    if (results[key] === 'bound') {
      await queueInitialSyncIfNeeded(key);
    }
  }
  return results;
}

/**
 * Re-bind the active server when indexed (legacy entry point for startup hooks).
 */
export async function ensureActiveServerSessionBound(): Promise<boolean> {
  const auth = useAuthStore.getState();
  const server = auth.activeServerId
    ? serverIndexOwnerForKey(auth, auth.activeServerId)
    : undefined;
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
