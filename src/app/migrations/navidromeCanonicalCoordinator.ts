import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { serverAddressEndpoints } from '@/lib/server/serverAddress';
import {
  serverHttpContextWireForProbe,
  serverHttpContextWireForProfile,
} from '@/lib/server/serverHttpHeaders';
import type { ServerProfile } from '@/store/authStoreTypes';
import {
  readRawAuthServerProfileGroups,
  type RawAuthServerProfileGroup,
} from './navidromeCanonicalAuth';
import {
  NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY,
  readNavidromeCanonicalMigrationCheckpoint,
  writeNavidromeCanonicalMigrationCheckpoint,
  type NavidromeCanonicalMigrationCheckpointV1,
  type NavidromeCanonicalMigrationPhase,
  type NavidromeCanonicalMigrationServerCheckpointV1,
} from './navidromeCanonicalCheckpoint';
export { NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY } from './navidromeCanonicalCheckpoint';
import {
  classifyNavidromeCanonicalVersion,
  type SuccessfulPingIdentity,
} from './navidromeCanonicalVersion';
import {
  rewriteNavidromeCanonicalFrontendState,
  verifyNavidromeCanonicalFrontendState,
  type NavidromeCanonicalFrontendScope,
} from './navidromeCanonicalFrontend';
import {
  inspectNavidromeCoverIdbUpperKey,
  invalidateNavidromeLyricsIdb,
  migrateNavidromeCoverIdbBatch,
  verifyNavidromeCoverIdb,
} from './navidromeCanonicalIdb';
import { rewriteNavidromeCanonicalHistoryForScope } from './navidromeCanonicalHistory';

const NATIVE_STEPS = ['artist', 'album', 'track'] as const;
const ANALYSIS_STEPS = ['analysis-track', 'waveform-cache', 'loudness-cache'] as const;
const BLOCKING_PHASES = new Set<NavidromeCanonicalMigrationPhase>([
  'pending',
  'native',
  'analysis',
  'cover',
  'frontend',
  'cleanup',
  'sync',
  'blocked',
]);
const SYNC_TIMEOUT_MS = 30 * 60 * 1_000;

type NativeStep = typeof NATIVE_STEPS[number];
type AnalysisStep = typeof ANALYSIS_STEPS[number];

type ProbeResult = {
  ok: boolean;
  type?: string | null;
  serverVersion?: string | null;
  openSubsonic?: boolean;
  error?: string | null;
};

type ReachableServer = {
  group: RawAuthServerProfileGroup;
  profile: ServerProfile;
  baseUrl: string;
  ping: ProbeResult;
};

type MigrationSnapshot =
  | { state: 'inactive'; lastGeneration: number }
  | {
      state: 'active';
      generation: number;
      servers: Array<{ serverId: string; phase: NavidromeCanonicalMigrationPhase; error?: string | null }>;
    };

type MigrationBatch = {
  cursorRowid: number;
  upperRowid: number;
  done: boolean;
};

type SyncJob = { jobId: string; serverId: string; kind: string };
type SyncIdle = {
  serverId: string;
  libraryScope: string;
  kind: string;
  source?: string;
  jobId?: string | null;
  ok: boolean;
  error?: string | null;
};

export type NavidromeCanonicalMigrationProgress = {
  serverId: string | null;
  phase: NavidromeCanonicalMigrationPhase | 'probing' | 'idle';
  step: string | null;
  completed: number;
  total: number;
};

export type NavidromeCanonicalBootstrapResult = {
  blocked: boolean;
  migratedServers: number;
};

type CoordinatorOptions = {
  windowKind: 'main' | 'mini';
  storage?: Storage;
  onProgress?: (progress: NavidromeCanonicalMigrationProgress) => void;
};

function now(): number {
  return Date.now();
}

function emptyCheckpoint(): NavidromeCanonicalMigrationCheckpointV1 {
  return { version: 1, servers: {} };
}

function readCheckpoint(storage: Storage): NavidromeCanonicalMigrationCheckpointV1 {
  return readNavidromeCanonicalMigrationCheckpoint(storage) ?? emptyCheckpoint();
}

function setBootstrapLock(storage: Storage): void {
  storage.setItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY, '1');
  if (storage.getItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY) !== '1') {
    throw new Error('Could not persist canonical migration bootstrap lock');
  }
}

function clearBootstrapLock(storage: Storage): void {
  storage.removeItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY);
  if (storage.getItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY) !== null) {
    throw new Error('Could not clear canonical migration bootstrap lock');
  }
}

function defaultServerCheckpoint(
  sourceVersion: string | null,
  phase: NavidromeCanonicalMigrationPhase,
): NavidromeCanonicalMigrationServerCheckpointV1 {
  const timestamp = now();
  return {
    sourceVersion,
    checkedVersion: null,
    canonicalVersion: 1,
    phase,
    step: null,
    cursorRowid: 0,
    upperRowid: 0,
    cursorKey: null,
    upperKey: null,
    startedAt: timestamp,
    updatedAt: timestamp,
    localCompletedAt: null,
    syncCompletedAt: null,
    lastError: null,
  };
}

function checkpointHasCanonicalNamespace(
  checkpoint: NavidromeCanonicalMigrationServerCheckpointV1 | undefined,
): boolean {
  return Boolean(checkpoint?.checkedVersion
    && classifyNavidromeCanonicalVersion({
      type: 'navidrome',
      serverVersion: checkpoint.checkedVersion,
    }) === 'canonical');
}

function rawAuthState(storage: Storage): Record<string, unknown> {
  const raw = storage.getItem('psysonic-auth');
  if (!raw) return {};
  try {
    const root = JSON.parse(raw) as unknown;
    if (!root || typeof root !== 'object' || Array.isArray(root)) return {};
    const state = (root as { state?: unknown }).state;
    return state && typeof state === 'object' && !Array.isArray(state)
      ? state as Record<string, unknown>
      : {};
  } catch {
    throw new Error('Malformed psysonic-auth JSON');
  }
}

function frontendScope(
  group: RawAuthServerProfileGroup,
  groups: readonly RawAuthServerProfileGroup[],
): NavidromeCanonicalFrontendScope {
  return {
    serverIndexKey: group.serverIndexKey,
    profileIds: group.profiles.map(profile => profile.id),
    profileServerIndexKeys: Object.fromEntries(groups.flatMap(candidate => (
      candidate.profiles.map(profile => [profile.id, candidate.serverIndexKey] as const)
    ))),
  };
}

async function probeGroup(group: RawAuthServerProfileGroup): Promise<ReachableServer | null> {
  for (const profile of group.profiles) {
    const httpContext = serverHttpContextWireForProbe(profile);
    for (const endpoint of serverAddressEndpoints(profile)) {
      let ping: ProbeResult;
      try {
        ping = await invoke<ProbeResult>('probe_server_connection', {
          baseUrl: endpoint.url,
          username: profile.username,
          password: profile.password,
          httpContext,
        });
      } catch {
        continue;
      }
      if (ping.ok) return { group, profile, baseUrl: endpoint.url, ping };
    }
  }
  return null;
}

function checkpointWriter(storage: Storage, initial: NavidromeCanonicalMigrationCheckpointV1) {
  let checkpoint = initial;
  return {
    get: (serverId: string) => checkpoint.servers[serverId],
    set: (
      serverId: string,
      sourceVersion: string | null,
      patch: Partial<NavidromeCanonicalMigrationServerCheckpointV1>,
    ) => {
      const previous = checkpoint.servers[serverId] ?? defaultServerCheckpoint(sourceVersion, 'pending');
      const next: NavidromeCanonicalMigrationServerCheckpointV1 = {
        ...previous,
        ...patch,
        sourceVersion,
        updatedAt: now(),
      };
      checkpoint = {
        version: 1,
        servers: { ...checkpoint.servers, [serverId]: next },
      };
      writeNavidromeCanonicalMigrationCheckpoint(checkpoint, storage);
      return next;
    },
    value: () => checkpoint,
  };
}

async function updateBackendPhase(
  generation: number,
  serverId: string,
  phase: NavidromeCanonicalMigrationPhase,
): Promise<void> {
  await invoke('library_migration_update_phase', { generation, serverId, phase });
}

async function runNativePhase(args: {
  generation: number;
  server: ReachableServer;
  write: ReturnType<typeof checkpointWriter>;
  authState: Record<string, unknown>;
  progress: (phase: NavidromeCanonicalMigrationPhase, step: string | null) => void;
}): Promise<void> {
  const { generation, server, write, authState, progress } = args;
  const serverId = server.group.serverIndexKey;
  const sourceVersion = server.ping.serverVersion ?? null;
  const savedBeforePhase = write.get(serverId);
  await updateBackendPhase(generation, serverId, 'native');
  write.set(serverId, sourceVersion, {
    phase: 'native',
    step: savedBeforePhase?.phase === 'native' ? savedBeforePhase.step : 'legacy-offline-disk',
    lastError: null,
  });
  const savedStep = write.get(serverId)?.step;
  if (savedStep === 'legacy-offline-disk' || !NATIVE_STEPS.includes(savedStep as NativeStep)) {
    progress('native', 'legacy-offline-disk');
    await invoke('migrate_navidrome_filesystem_ids', {
      generation,
      libraryServerId: serverId,
      serverIndexKey: serverId,
      customOfflineDir: typeof authState.offlineDownloadDir === 'string' ? authState.offlineDownloadDir : null,
      customHotCacheDir: typeof authState.hotCacheDownloadDir === 'string' ? authState.hotCacheDownloadDir : null,
    });
    write.set(serverId, sourceVersion, { phase: 'native', step: NATIVE_STEPS[0] });
  }
  progress('native', 'preflight');
  await invoke('library_migration_native_preflight', { generation, serverId });

  const saved = write.get(serverId);
  const savedIndex = saved?.phase === 'native'
    ? NATIVE_STEPS.indexOf(saved.step as NativeStep)
    : -1;
  const startIndex = savedIndex >= 0 ? savedIndex : 0;
  for (let index = startIndex; index < NATIVE_STEPS.length; index += 1) {
    const step = NATIVE_STEPS[index];
    progress('native', step);
    const resume = write.get(serverId);
    let cursorRowid = resume?.phase === 'native' && resume.step === step ? resume.cursorRowid : 0;
    let upperRowid = resume?.phase === 'native' && resume.step === step ? resume.upperRowid : 0;
    if (upperRowid === 0) {
      upperRowid = await invoke<number>('library_migration_native_upper_rowid', {
        generation,
        serverId,
        step,
      });
      cursorRowid = 0;
      write.set(serverId, sourceVersion, {
        phase: 'native', step, cursorRowid, upperRowid, cursorKey: null, upperKey: null,
      });
    }
    while (cursorRowid < upperRowid) {
      const batch = await invoke<MigrationBatch>('library_migration_native_batch', {
        generation,
        serverId,
        step,
        cursorRowid,
        upperRowid,
        limit: 1_000,
      });
      if (batch.cursorRowid <= cursorRowid && !batch.done) {
        throw new Error(`Native migration made no progress in ${step}`);
      }
      cursorRowid = batch.cursorRowid;
      write.set(serverId, sourceVersion, { phase: 'native', step, cursorRowid, upperRowid });
      if (batch.done) break;
    }
    const nextStep = NATIVE_STEPS[index + 1] ?? null;
    write.set(serverId, sourceVersion, {
      phase: 'native', step: nextStep, cursorRowid: 0, upperRowid: 0,
    });
  }
  progress('native', 'finalize');
  await invoke('library_migration_native_finalize', { generation, serverId });
}

async function runAnalysisPhase(args: {
  generation: number;
  server: ReachableServer;
  write: ReturnType<typeof checkpointWriter>;
  progress: (phase: NavidromeCanonicalMigrationPhase, step: string | null) => void;
}): Promise<void> {
  const { generation, server, write, progress } = args;
  const serverId = server.group.serverIndexKey;
  const sourceVersion = server.ping.serverVersion ?? null;
  await updateBackendPhase(generation, serverId, 'analysis');
  write.set(serverId, sourceVersion, {
    phase: 'analysis', step: write.get(serverId)?.phase === 'analysis' ? write.get(serverId)?.step : null,
    cursorRowid: write.get(serverId)?.phase === 'analysis' ? write.get(serverId)?.cursorRowid ?? 0 : 0,
    upperRowid: write.get(serverId)?.phase === 'analysis' ? write.get(serverId)?.upperRowid ?? 0 : 0,
  });
  const saved = write.get(serverId);
  const savedIndex = saved?.phase === 'analysis'
    ? ANALYSIS_STEPS.indexOf(saved.step as AnalysisStep)
    : -1;
  const startIndex = savedIndex >= 0 ? savedIndex : 0;
  for (let index = startIndex; index < ANALYSIS_STEPS.length; index += 1) {
    const step = ANALYSIS_STEPS[index];
    progress('analysis', step);
    const resume = write.get(serverId);
    let cursorRowid = resume?.phase === 'analysis' && resume.step === step ? resume.cursorRowid : 0;
    let upperRowid = resume?.phase === 'analysis' && resume.step === step ? resume.upperRowid : 0;
    if (upperRowid === 0) {
      upperRowid = await invoke<number>('library_migration_analysis_upper_rowid', {
        generation,
        serverId,
        step,
      });
      cursorRowid = 0;
      write.set(serverId, sourceVersion, {
        phase: 'analysis', step, cursorRowid, upperRowid, cursorKey: null, upperKey: null,
      });
    }
    while (cursorRowid < upperRowid) {
      const batch = await invoke<MigrationBatch>('library_migration_analysis_batch', {
        request: { generation, serverId, step, cursorRowid, upperRowid, limit: 2_000 },
      });
      if (batch.cursorRowid <= cursorRowid && !batch.done) {
        throw new Error(`Analysis migration made no progress in ${step}`);
      }
      cursorRowid = batch.cursorRowid;
      write.set(serverId, sourceVersion, { phase: 'analysis', step, cursorRowid, upperRowid });
      if (batch.done) break;
    }
    const nextStep = ANALYSIS_STEPS[index + 1] ?? null;
    write.set(serverId, sourceVersion, {
      phase: 'analysis', step: nextStep, cursorRowid: 0, upperRowid: 0,
    });
  }
  progress('analysis', 'finalize');
  await invoke('library_migration_analysis_finalize', { generation, serverId });
}

async function runCoverPhase(args: {
  generation: number;
  server: ReachableServer;
  write: ReturnType<typeof checkpointWriter>;
  progress: (phase: NavidromeCanonicalMigrationPhase, step: string | null) => void;
}): Promise<void> {
  const { generation, server, write, progress } = args;
  const serverId = server.group.serverIndexKey;
  const sourceVersion = server.ping.serverVersion ?? null;
  const saved = write.get(serverId);
  const savedStep = saved?.phase === 'cover' ? saved.step : null;
  await updateBackendPhase(generation, serverId, 'cover');
  if (savedStep !== 'cover-idb') {
    write.set(serverId, sourceVersion, { phase: 'cover', step: 'cover-disk' });
    progress('cover', 'cover-disk');
    await invoke('cover_cache_migrate_navidrome_ids', {
      generation,
      serverId,
      serverIndexKey: serverId,
    });
  }

  let cursorKey = savedStep === 'cover-idb' ? saved?.cursorKey ?? null : null;
  let upperKey = savedStep === 'cover-idb' ? saved?.upperKey ?? null : null;
  if (savedStep !== 'cover-idb') {
    upperKey = await inspectNavidromeCoverIdbUpperKey(serverId);
    cursorKey = null;
  }
  write.set(serverId, sourceVersion, {
    phase: 'cover', step: 'cover-idb', cursorKey, upperKey, cursorRowid: 0, upperRowid: 0,
  });
  progress('cover', 'cover-idb');
  while (upperKey && cursorKey !== upperKey) {
    const batch = await migrateNavidromeCoverIdbBatch({ serverIndexKey: serverId, cursorKey, upperKey });
    if (batch.cursorKey === cursorKey && !batch.done) throw new Error('Cover IndexedDB migration made no progress');
    cursorKey = batch.cursorKey;
    write.set(serverId, sourceVersion, { phase: 'cover', step: 'cover-idb', cursorKey, upperKey });
    if (batch.done) break;
  }
  await verifyNavidromeCoverIdb(serverId);
}

async function waitForMigrationSync(args: {
  generation: number;
  server: ReachableServer;
}): Promise<void> {
  const { generation, server } = args;
  const serverId = server.group.serverIndexKey;
  await invoke('server_http_context_sync', {
    wire: serverHttpContextWireForProfile(server.profile, {
      type: server.ping.type ?? undefined,
      serverVersion: server.ping.serverVersion ?? undefined,
      openSubsonic: server.ping.openSubsonic === true,
    }),
  });
  await invoke('library_migration_bind_session', {
    request: {
      generation,
      serverId,
      baseUrl: server.baseUrl,
      username: server.profile.username,
      password: server.profile.password,
      libraryScope: null,
    },
  });

  let expectedJobId: string | null = null;
  const earlyEvents: SyncIdle[] = [];
  let resolveCompletion!: () => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const timeout = window.setTimeout(
    () => rejectCompletion(new Error('Canonical migration full sync timed out')),
    SYNC_TIMEOUT_MS,
  );
  const finish = (payload: SyncIdle) => {
    if (payload.serverId !== serverId || !payload.jobId) return;
    if (!expectedJobId) {
      earlyEvents.push(payload);
      return;
    }
    if (payload.jobId !== expectedJobId) return;
    window.clearTimeout(timeout);
    if (payload.ok) resolveCompletion();
    else rejectCompletion(new Error(payload.error || 'Canonical migration full sync failed'));
  };
  const unlisten: UnlistenFn = await listen<SyncIdle>(
    'library:sync-idle',
    ({ payload }) => finish(payload),
  );
  try {
    const job = await invoke<SyncJob>('library_migration_sync_start', {
      generation,
      serverId,
      libraryScope: null,
    });
    expectedJobId = job.jobId;
    const early = earlyEvents.find(event => event.jobId === expectedJobId);
    if (early) {
      window.clearTimeout(timeout);
      if (!early.ok) throw new Error(early.error || 'Canonical migration full sync failed');
      return;
    }
    await completion;
  } finally {
    window.clearTimeout(timeout);
    unlisten();
  }
}

async function inspectBackend(): Promise<MigrationSnapshot> {
  return invoke<MigrationSnapshot>('library_migration_inspect');
}

async function discardCommittedImportBackups(): Promise<void> {
  await invoke('backup_commit_imported_databases').catch(() => {});
}

async function verifyCanonicalInventory(args: {
  serverId: string;
  scope: NavidromeCanonicalFrontendScope;
  authState: Record<string, unknown>;
  storage: Storage;
}): Promise<void> {
  const { serverId, scope, authState, storage } = args;
  await invoke('library_migration_inventory', {
    serverId,
    serverIndexKey: serverId,
    customOfflineDir: typeof authState.offlineDownloadDir === 'string' ? authState.offlineDownloadDir : null,
    customHotCacheDir: typeof authState.hotCacheDownloadDir === 'string' ? authState.hotCacheDownloadDir : null,
  });
  rewriteNavidromeCanonicalHistoryForScope(scope, storage);
  await verifyNavidromeCoverIdb(serverId);
  verifyNavidromeCanonicalFrontendState(storage, scope);
}

export function navidromeCanonicalCheckpointIsBlocking(storage: Storage = localStorage): boolean {
  if (storage.getItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY) !== null) return true;
  try {
    const checkpoint = readNavidromeCanonicalMigrationCheckpoint(storage);
    return Boolean(checkpoint && Object.values(checkpoint.servers).some(server => BLOCKING_PHASES.has(server.phase)));
  } catch {
    return storage.getItem('psysonic-navidrome-canonical-id-migration-v1') !== null;
  }
}

let runtimeObservationQueue: Promise<void> = Promise.resolve();

/**
 * Admit a successful runtime ping or arm the global writer gate for a minimal-root reload.
 * Returns `true` when the caller must reload and must not publish the endpoint.
 */
async function observeNavidromeCanonicalSuccessfulPingNow(args: {
  profile: ServerProfile;
  ping: SuccessfulPingIdentity;
  storage?: Storage;
}): Promise<boolean> {
  const storage = args.storage ?? localStorage;
  const groups = readRawAuthServerProfileGroups(storage);
  const group = groups.find(candidate => candidate.profiles.some(profile => profile.id === args.profile.id));
  if (!group) throw new Error(`Could not resolve canonical migration owner for ${args.profile.id}`);
  const serverId = group.serverIndexKey;
  const sourceVersion = args.ping.serverVersion ?? null;
  const classification = classifyNavidromeCanonicalVersion(args.ping);
  const checkpoint = readCheckpoint(storage);
  const write = checkpointWriter(storage, checkpoint);
  const saved = write.get(serverId);

  if (classification !== 'canonical') {
    if (checkpointHasCanonicalNamespace(saved)) {
      const message = `Navidrome canonical ID namespace for ${serverId} cannot be downgraded after ${saved?.checkedVersion}`;
      const generation = await invoke<number>('library_migration_begin', { serverIds: [serverId] });
      setBootstrapLock(storage);
      write.set(serverId, sourceVersion, {
        phase: 'blocked',
        checkedVersion: saved?.checkedVersion ?? null,
        lastError: message,
      });
      await invoke('library_migration_abort', { generation, serverId, error: message });
      return true;
    }
    if (saved && BLOCKING_PHASES.has(saved.phase)) {
      throw new Error(
        `Canonical ID migration for ${serverId} cannot discard its ${saved.phase} checkpoint after a ${classification} probe`,
      );
    }
    const checkedVersion = classification === 'retryable' ? null : sourceVersion;
    if (saved?.phase === classification
      && saved.sourceVersion === sourceVersion
      && saved.checkedVersion === checkedVersion) return false;
    write.set(serverId, sourceVersion, {
      phase: classification,
      checkedVersion,
      step: null,
      cursorRowid: 0,
      upperRowid: 0,
      cursorKey: null,
      upperKey: null,
      lastError: null,
    });
    return false;
  }

  if (saved?.phase === 'ready' && saved.checkedVersion === sourceVersion) return false;

  await invoke('library_migration_begin', { serverIds: [serverId] });
  setBootstrapLock(storage);
  write.set(serverId, sourceVersion, {
    phase: 'pending',
    checkedVersion: saved?.checkedVersion ?? null,
    step: null,
    cursorRowid: 0,
    upperRowid: 0,
    cursorKey: null,
    upperKey: null,
    lastError: null,
  });
  return true;
}

export function observeNavidromeCanonicalSuccessfulPing(args: {
  profile: ServerProfile;
  ping: SuccessfulPingIdentity;
  storage?: Storage;
}): Promise<boolean> {
  const observation = runtimeObservationQueue.then(
    () => observeNavidromeCanonicalSuccessfulPingNow(args),
    () => observeNavidromeCanonicalSuccessfulPingNow(args),
  );
  runtimeObservationQueue = observation.then(() => undefined, () => undefined);
  return observation;
}

/** Run before importing App or any identity-bearing Zustand store. */
export async function runNavidromeCanonicalMigrationCoordinator(
  options: CoordinatorOptions,
): Promise<NavidromeCanonicalBootstrapResult> {
  const storage = options.storage ?? localStorage;
  const emit = (
    serverId: string | null,
    phase: NavidromeCanonicalMigrationProgress['phase'],
    step: string | null,
    completed: number,
    total: number,
  ) => options.onProgress?.({ serverId, phase, step, completed, total });
  if (options.windowKind === 'main') setBootstrapLock(storage);
  const complete = (result: NavidromeCanonicalBootstrapResult) => {
    clearBootstrapLock(storage);
    return result;
  };
  const backendAtStart = await inspectBackend();
  if (options.windowKind === 'mini') {
    return {
      blocked: backendAtStart.state === 'active' || navidromeCanonicalCheckpointIsBlocking(storage),
      migratedServers: 0,
    };
  }

  const groups = readRawAuthServerProfileGroups(storage);
  const authState = rawAuthState(storage);
  const checkpoint = readCheckpoint(storage);
  const write = checkpointWriter(storage, checkpoint);
  const finishedBackendServerIds = new Set<string>();
  const configuredServerIds = new Set(groups.map(group => group.serverIndexKey));
  const removedBlockingServer = Object.entries(checkpoint.servers).find(([serverId, saved]) => (
    !configuredServerIds.has(serverId) && BLOCKING_PHASES.has(saved.phase)
  ));
  if (removedBlockingServer) {
    throw new Error(
      `Canonical ID migration for ${removedBlockingServer[0]} cannot resume because its server profile is no longer configured`,
    );
  }
  if (groups.length === 0) {
    if (backendAtStart.state === 'active'
      && backendAtStart.servers.some(server => !['ready', 'legacy', 'not-applicable'].includes(server.phase))) {
      throw new Error('A canonical ID migration is active but no configured server profile can resume it');
    }
    if (backendAtStart.state === 'active') {
      await invoke('library_migration_release', { generation: backendAtStart.generation });
    }
    await discardCommittedImportBackups();
    return complete({ blocked: false, migratedServers: 0 });
  }
  const reachable: ReachableServer[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    emit(group.serverIndexKey, 'probing', null, index, groups.length);
    const server = await probeGroup(group);
    if (server) reachable.push(server);
  }

  const reachableIds = new Set(reachable.map(server => server.group.serverIndexKey));
  const unavailableBlocking = groups.find(group => {
    const saved = checkpoint.servers[group.serverIndexKey];
    return !reachableIds.has(group.serverIndexKey) && saved && BLOCKING_PHASES.has(saved.phase);
  });
  if (unavailableBlocking) {
    throw new Error(
      `Canonical ID migration for ${unavailableBlocking.serverIndexKey} cannot resume while the server is unreachable`,
    );
  }

  const migrationServers: ReachableServer[] = [];
  for (const server of reachable) {
    const serverId = server.group.serverIndexKey;
    const sourceVersion = server.ping.serverVersion ?? null;
    const classification = classifyNavidromeCanonicalVersion(server.ping);
    const saved = write.get(serverId);
    if (classification === 'canonical') {
      const canInventoryWithoutFullSync = saved?.phase === 'ready'
        || (saved?.phase === 'pending'
          && saved.checkedVersion !== null
          && saved.localCompletedAt !== null
          && saved.syncCompletedAt !== null);
      if (canInventoryWithoutFullSync) {
        try {
          await verifyCanonicalInventory({
            serverId,
            scope: frontendScope(server.group, groups),
            authState,
            storage,
          });
          if (backendAtStart.state === 'active'
            && backendAtStart.servers.some(candidate => candidate.serverId === serverId && candidate.phase !== 'ready')) {
            await invoke('library_migration_finish_server', {
              generation: backendAtStart.generation,
              serverId,
              phase: 'ready',
            });
            finishedBackendServerIds.add(serverId);
          }
          write.set(serverId, sourceVersion, {
            phase: 'ready',
            checkedVersion: sourceVersion,
            lastError: null,
          });
          continue;
        } catch {
          // The checkpoint is advisory. Actual residue re-enters the migration.
        }
      }
      migrationServers.push(server);
      continue;
    }
    const pendingBackupImport = saved?.phase === 'pending' && saved.step === 'backup-import';
    if (pendingBackupImport && classification === 'retryable') {
      throw new Error(
        `Canonical ID namespace for imported server ${serverId} cannot be determined from its current version`,
      );
    }
    if (saved && BLOCKING_PHASES.has(saved.phase) && !pendingBackupImport) {
      throw new Error(
        `Canonical ID migration for ${serverId} cannot discard its ${saved.phase} checkpoint after a ${classification} probe`,
      );
    }
    if (checkpointHasCanonicalNamespace(saved)) {
      const message = `Navidrome canonical ID namespace for ${serverId} cannot be downgraded after ${saved?.checkedVersion}`;
      const generation = await invoke<number>('library_migration_begin', { serverIds: [serverId] });
      write.set(serverId, sourceVersion, {
        phase: 'blocked',
        checkedVersion: saved?.checkedVersion ?? null,
        lastError: message,
      });
      await invoke('library_migration_abort', { generation, serverId, error: message });
      throw new Error(message);
    }
    const phase: NavidromeCanonicalMigrationPhase = classification;
    write.set(serverId, sourceVersion, {
      phase,
      checkedVersion: classification === 'retryable' ? null : sourceVersion,
      step: null,
      cursorRowid: 0,
      upperRowid: 0,
      cursorKey: null,
      upperKey: null,
      lastError: null,
    });
    if (pendingBackupImport && backendAtStart.state === 'active'
      && backendAtStart.servers.some(candidate => candidate.serverId === serverId)) {
      await invoke('library_migration_finish_server', {
        generation: backendAtStart.generation,
        serverId,
        phase,
      });
      finishedBackendServerIds.add(serverId);
    }
  }

  if (migrationServers.length === 0) {
    if (backendAtStart.state === 'active'
      && backendAtStart.servers.every(server => (
        finishedBackendServerIds.has(server.serverId)
        || ['ready', 'legacy', 'not-applicable'].includes(server.phase)
      ))) {
      await invoke('library_migration_release', { generation: backendAtStart.generation });
    }
    if (backendAtStart.state === 'active'
      && backendAtStart.servers.some(server => (
        !finishedBackendServerIds.has(server.serverId)
        && !['ready', 'legacy', 'not-applicable'].includes(server.phase)
      ))) {
      throw new Error('A canonical ID migration is active for a server that is currently unreachable');
    }
    emit(null, 'idle', null, groups.length, groups.length);
    await discardCommittedImportBackups();
    return complete({ blocked: false, migratedServers: 0 });
  }

  let generation: number;
  try {
    generation = await invoke<number>('library_migration_begin', {
      serverIds: migrationServers.map(server => server.group.serverIndexKey),
    });
  } catch (error) {
    const wrapped = new Error(`Could not start canonical ID migration: ${String(error)}`) as Error & {
      cause?: unknown;
    };
    wrapped.cause = error;
    throw wrapped;
  }

  let migratedServers = 0;
  for (let index = 0; index < migrationServers.length; index += 1) {
    const server = migrationServers[index];
    const serverId = server.group.serverIndexKey;
    const sourceVersion = server.ping.serverVersion ?? null;
    const progress = (phase: NavidromeCanonicalMigrationPhase, step: string | null) => {
      emit(serverId, phase, step, index, migrationServers.length);
    };
    try {
      const active = await inspectBackend();
      const activeServer = active.state === 'active'
        ? active.servers.find(candidate => candidate.serverId === serverId)
        : null;
      if (active.state === 'active' && activeServer?.phase === 'blocked') {
        await invoke('library_migration_retry', { generation, serverId });
      }
      const scope = frontendScope(server.group, groups);
      let resume = write.get(serverId);
      const resumable = resume?.sourceVersion === sourceVersion
        && ['native', 'analysis', 'cover', 'frontend', 'cleanup', 'sync'].includes(resume.phase);
      if (!resumable || resume?.phase === 'blocked') {
        resume = write.set(serverId, sourceVersion, {
          phase: 'pending', checkedVersion: null, step: null, lastError: null,
          cursorRowid: 0, upperRowid: 0, cursorKey: null, upperKey: null,
          localCompletedAt: null, syncCompletedAt: null,
        });
      }

      const phase = resume?.phase ?? 'pending';
      if (phase === 'pending' || phase === 'native') {
        await runNativePhase({ generation, server, write, authState, progress });
      }
      if (phase === 'pending' || phase === 'native' || phase === 'analysis') {
        await runAnalysisPhase({ generation, server, write, progress });
      }
      if (phase === 'pending' || phase === 'native' || phase === 'analysis' || phase === 'cover') {
        await runCoverPhase({ generation, server, write, progress });
      }
      if (['pending', 'native', 'analysis', 'cover', 'frontend'].includes(phase)) {
        await updateBackendPhase(generation, serverId, 'frontend');
        write.set(serverId, sourceVersion, { phase: 'frontend', step: 'raw-persistence' });
        progress('frontend', 'raw-persistence');
        rewriteNavidromeCanonicalFrontendState(scope, storage);
        rewriteNavidromeCanonicalHistoryForScope(scope, storage);
      }

      if (phase !== 'sync' && !write.get(serverId)?.syncCompletedAt) {
        await updateBackendPhase(generation, serverId, 'cleanup');
        write.set(serverId, sourceVersion, { phase: 'cleanup', step: 'derived-caches' });
        progress('cleanup', 'derived-caches');
        await invalidateNavidromeLyricsIdb([serverId, ...scope.profileIds]);
        await invoke('library_migration_verify', { generation, serverId });
        await verifyNavidromeCoverIdb(serverId);
        verifyNavidromeCanonicalFrontendState(storage, scope);
        write.set(serverId, sourceVersion, { localCompletedAt: now() });
      }

      if (!write.get(serverId)?.syncCompletedAt) {
        await updateBackendPhase(generation, serverId, 'sync');
        write.set(serverId, sourceVersion, { phase: 'sync', step: 'authoritative-full-sync' });
        progress('sync', 'authoritative-full-sync');
        await waitForMigrationSync({ generation, server });
        write.set(serverId, sourceVersion, { syncCompletedAt: now() });
      }

      await updateBackendPhase(generation, serverId, 'cleanup');
      write.set(serverId, sourceVersion, { phase: 'cleanup', step: 'final-verification' });
      progress('cleanup', 'final-verification');
      await invoke('library_migration_verify', { generation, serverId });
      rewriteNavidromeCanonicalHistoryForScope(scope, storage);
      await verifyNavidromeCoverIdb(serverId);
      verifyNavidromeCanonicalFrontendState(storage, scope);

      const completedAt = now();
      await invoke('library_migration_finish_server', { generation, serverId, phase: 'ready' });
      write.set(serverId, sourceVersion, {
        phase: 'ready',
        checkedVersion: sourceVersion,
        step: null,
        cursorRowid: 0,
        upperRowid: 0,
        cursorKey: null,
        upperKey: null,
        localCompletedAt: write.get(serverId)?.localCompletedAt ?? completedAt,
        syncCompletedAt: completedAt,
        lastError: null,
      });
      migratedServers += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      write.set(serverId, sourceVersion, { phase: 'blocked', lastError: message });
      await invoke('library_migration_abort', { generation, serverId, error: message }).catch(() => {});
      throw error;
    }
  }

  await invoke('library_migration_release', { generation });
  await discardCommittedImportBackups();
  emit(null, 'idle', null, migrationServers.length, migrationServers.length);
  return complete({ blocked: false, migratedServers });
}
