import {
  libraryGetStatus,
  librarySyncBindSession,
} from '@/lib/api/library';
import {
  enqueueLibrarySync,
  hasLibrarySyncWork,
  queueInitialSyncIfNeeded,
} from './librarySyncQueue';
import type { ServerProfile } from '@/store/authStoreTypes';
import { useAuthStore } from '@/store/authStore';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { ensureConnectUrlResolved } from '@/lib/server/serverEndpoint';
import { serverIndexKeyForProfile } from '@/lib/server/serverIndexKey';
import {
  syncAllServerHttpContexts,
  syncServerHttpContextForProfile,
} from '@/lib/server/syncServerHttpContext';
import {
  libraryCoverBackfillRunFullPass,
  libraryCoverClearFetchFailures,
} from '@/lib/api/coverCache';
import { libraryDevEnabled, logLibraryStatus, logLibrarySync, timed } from './libraryDevLog';
import { publishServerConnectionStatus } from '@/lib/network/serverReachability';

export type BindServerResult = 'bound' | 'offline' | 'error';

interface BindFlight {
  latestServer: ServerProfile;
  promise: Promise<BindServerResult>;
}

const bindInFlightByIndexKey = new Map<string, BindFlight>();

function bindProfileFingerprint(server: ServerProfile): string {
  return JSON.stringify([
    server.url,
    server.alternateUrl ?? '',
    server.username,
    server.password,
    server.customHeaders ?? [],
    server.customHeadersApplyTo ?? '',
  ]);
}

function currentProfileMatches(server: ServerProfile, serverIndexKey: string): boolean {
  const current = useAuthStore.getState().servers.find(candidate => candidate.id === server.id);
  return current != null
    && bindProfileFingerprint(current) === bindProfileFingerprint(server)
    && serverIndexKeyForProfile(current) === serverIndexKey;
}

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
async function bindIndexedServerOnce(
  server: ServerProfile,
  serverIndexKey: string,
): Promise<BindServerResult> {
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
  if (!currentProfileMatches(server, serverIndexKey)) return 'error';
  const baseUrl = probe.baseUrl;

  try {
    const t0 = performance.now();
    await librarySyncBindSession({
      serverId: serverIndexKey,
      baseUrl,
      username: server.username,
      password: server.password,
    });
    if (libraryDevEnabled()) {
      const { result: status, ms } = await timed(() => libraryGetStatus(serverIndexKey));
      logLibrarySync({
        at: new Date().toISOString(),
        kind: 'bind_session',
        serverId: serverIndexKey,
        ingestStrategy: status.ingestStrategy ?? null,
        ingestPhase: status.ingestPhase ?? null,
        syncPhase: status.syncPhase,
        n1BulkUnreliable: status.n1BulkUnreliable ?? null,
        durationMs: Math.round(performance.now() - t0),
        message: `status fetch ${ms}ms`,
      });
      logLibraryStatus(serverIndexKey, status, 'bind_session');
    }
    return 'bound';
  } catch {
    return 'error';
  }
}

export async function bindIndexedServer(server: ServerProfile): Promise<BindServerResult> {
  const serverIndexKey = serverIndexKeyForProfile(server);
  const existing = bindInFlightByIndexKey.get(serverIndexKey);
  if (existing) {
    existing.latestServer = server;
    const result = await existing.promise;
    const completedProfile = existing.latestServer;
    if (!currentProfileMatches(completedProfile, serverIndexKey)) return 'error';
    publishServerConnectionStatus(
      completedProfile.id,
      result === 'bound' ? 'online' : result === 'offline' ? 'offline' : 'unknown',
      useAuthStore.getState().activeServerId === completedProfile.id,
    );
    return result;
  }

  const flight = {} as BindFlight;
  flight.latestServer = server;
  flight.promise = (async () => {
    let profile = flight.latestServer;
    let result = await bindIndexedServerOnce(profile, serverIndexKey);
    while (bindProfileFingerprint(profile) !== bindProfileFingerprint(flight.latestServer)) {
      profile = flight.latestServer;
      result = await bindIndexedServerOnce(profile, serverIndexKey);
    }
    return result;
  })();
  bindInFlightByIndexKey.set(serverIndexKey, flight);
  try {
    const result = await flight.promise;
    const completedProfile = flight.latestServer;
    if (!currentProfileMatches(completedProfile, serverIndexKey)) return 'error';
    publishServerConnectionStatus(
      completedProfile.id,
      result === 'bound' ? 'online' : result === 'offline' ? 'offline' : 'unknown',
      useAuthStore.getState().activeServerId === completedProfile.id,
    );
    return result;
  } finally {
    if (bindInFlightByIndexKey.get(serverIndexKey) === flight) {
      bindInFlightByIndexKey.delete(serverIndexKey);
    }
  }
}

/** Bind one server without queuing ordinary startup sync work. */
export async function bindIndexedServerForMigration(server: ServerProfile): Promise<BindServerResult> {
  return bindIndexedServer(server);
}

/** Bind + kick off initial sync for one indexed server. */
export async function bootstrapIndexedServer(server: ServerProfile): Promise<BindServerResult> {
  const bound = await bindIndexedServer(server);
  if (bound !== 'bound') return bound;
  const indexKey = serverIndexKeyForProfile(server);
  if (!currentProfileMatches(server, indexKey)) return 'error';
  await resumeInitialSyncIfIncomplete(indexKey);
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
  await syncAllServerHttpContexts(auth.servers).catch(() => {});
  const active = auth.activeServerId
    ? auth.servers.find(s => s.id === auth.activeServerId) ?? null
    : null;
  const indexed = auth.servers.filter(s => lib.isIndexEnabled(s.id));
  const primaryByKey = new Map<string, ServerProfile>();
  for (const server of indexed) {
    const key = serverIndexKeyForProfile(server);
    if (!primaryByKey.has(key)) primaryByKey.set(key, server);
  }
  if (active) {
    const key = serverIndexKeyForProfile(active);
    if (primaryByKey.has(key)) primaryByKey.set(key, active);
  }
  const results: Record<string, BindServerResult> = {};
  for (const server of primaryByKey.values()) {
    const key = serverIndexKeyForProfile(server);
    results[key] = await bindIndexedServer(server);
  }
  for (const server of primaryByKey.values()) {
    const key = serverIndexKeyForProfile(server);
    if (results[key] === 'bound') {
      await resumeInitialSyncIfIncomplete(key);
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
  const server = auth.servers.find(s => s.id === auth.activeServerId);
  if (!server) return false;
  if (!useLibraryIndexStore.getState().isIndexEnabled(server.id)) return false;
  return (await bootstrapIndexedServer(server)) === 'bound';
}

const resumeInFlight = new Set<string>();

export async function resumeInitialSyncIfIncomplete(serverIndexKey: string): Promise<void> {
  if (resumeInFlight.has(serverIndexKey)) return;
  resumeInFlight.add(serverIndexKey);
  try {
    const { result: status, ms: statusMs } = await timed(() => libraryGetStatus(serverIndexKey));
    if (status.syncPhase === 'ready' || status.lastFullSyncAt) return;
    if (status.syncPhase !== 'initial_sync') return;
    if (hasLibrarySyncWork(serverIndexKey, 'full')) return;
    const resumeT0 = performance.now();
    await enqueueLibrarySync({ serverId: serverIndexKey, kind: 'full' });
    if (libraryDevEnabled()) {
      logLibrarySync({
        at: new Date().toISOString(),
        kind: 'resume_initial_sync',
        serverId: serverIndexKey,
        ingestStrategy: status.ingestStrategy ?? null,
        ingestPhase: status.ingestPhase ?? null,
        syncPhase: status.syncPhase,
        n1BulkUnreliable: status.n1BulkUnreliable ?? null,
        localTrackCount: status.localTrackCount ?? null,
        serverTrackCount: status.serverTrackCount ?? null,
        durationMs: Math.round(performance.now() - resumeT0),
        message: `status ${statusMs}ms`,
      });
      logLibraryStatus(serverIndexKey, status, 'resume_initial_sync');
    }
  } catch {
    /* best-effort */
  } finally {
    resumeInFlight.delete(serverIndexKey);
  }
}

export function resetLibrarySessionForTests(): void {
  bindInFlightByIndexKey.clear();
  resumeInFlight.clear();
}
