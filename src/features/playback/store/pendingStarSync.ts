import i18n from '@/lib/i18n';
import { libraryResolveEntitySources } from '@/lib/api/library/scopeReads';
import { setRatingForServer, star, unstar } from '@/lib/api/subsonicStarRating';
import { buildMutationLibraryScope } from '@/lib/library/libraryBrowseScope';
import { showToast } from '@/lib/dom/toast';
import { resolveIndexKey } from '@/lib/server/serverIndexKey';
import { useAuthStore } from '@/store/authStore';
import { registerEntityMutationBridge } from '@/store/entityMutationBridge';
import { useLibraryIndexStore } from '@/store/libraryIndexStore';
import { usePlayerStore } from './playerStore';
import { patchCachedTrack } from './queueTrackResolver';

export type PendingEntityType = 'track' | 'album' | 'artist';
export type PendingEntityOperation = 'star' | 'rating';

export interface PendingEntityMutation {
  targetServerId: string;
  entityType: PendingEntityType;
  entityId?: string;
  anchorServerId: string;
  anchorId: string;
  operation: PendingEntityOperation;
  value: boolean | number;
  resolution: 'resolved' | 'awaiting_index';
  updatedAt: number;
  attempts: number;
}

const STORAGE_KEY = 'psysonic-entity-mutation-outbox-v1';
const MAX_BACKOFF_MS = 30_000;
const MAX_CONCURRENT = 4;
const pending = new Map<string, PendingEntityMutation>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Set<string>();
let listenersArmed = false;
let clock = 0;

function nextUpdatedAt(): number {
  clock = Math.max(Date.now(), clock + 1);
  return clock;
}

function resolvedKey(task: Pick<PendingEntityMutation, 'targetServerId' | 'entityType' | 'entityId' | 'operation'>): string {
  return `resolved:${task.targetServerId}:${task.entityType}:${task.entityId ?? ''}:${task.operation}`;
}

function deferredKey(task: Pick<PendingEntityMutation, 'targetServerId' | 'anchorServerId' | 'anchorId' | 'entityType' | 'operation'>): string {
  return `deferred:${task.targetServerId}:${task.anchorServerId}:${task.anchorId}:${task.entityType}:${task.operation}`;
}

function keyOf(task: PendingEntityMutation): string {
  return task.resolution === 'resolved' ? resolvedKey(task) : deferredKey(task);
}

function persist(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...pending.values()]));
  } catch { /* best effort; writes still execute in this session */ }
}

function restore(): void {
  if (typeof localStorage === 'undefined' || pending.size > 0) return;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as PendingEntityMutation[];
    for (const task of parsed) {
      if (!task?.targetServerId || !task.anchorServerId || !task.anchorId || !task.operation) continue;
      const existing = pending.get(keyOf(task));
      if (!existing || task.updatedAt > existing.updatedAt) pending.set(keyOf(task), task);
      clock = Math.max(clock, task.updatedAt || 0);
    }
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function mutationScope() {
  const auth = useAuthStore.getState();
  const library = useLibraryIndexStore.getState();
  return buildMutationLibraryScope(auth, {
    statusByServer: library.statusByServer,
    connectionByServer: library.connectionByServer,
  });
}

function isOnline(serverId: string): boolean {
  return useLibraryIndexStore.getState().connectionByServer[resolveIndexKey(serverId)] === 'online';
}

function isPermanentUnsupported(task: PendingEntityMutation, error?: unknown): boolean {
  if (task.operation !== 'rating' || task.entityType === 'track') return false;
  const support = useAuthStore.getState().entityRatingSupportByServer[task.targetServerId] ?? 'unknown';
  if (support === 'track_only') return true;
  const status = error && typeof error === 'object' && 'response' in error
    ? (error as { response?: { status?: number } }).response?.status
    : undefined;
  if (status && [400, 404, 405, 501].includes(status)) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase();
  return message.includes('not supported')
    || message.includes('unsupported')
    || message.includes('unknown endpoint')
    || message.includes('unknown method');
}

function isPermanentNoMatch(error: unknown): boolean {
  if (error === 'no_matching_copy') return true;
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; kind?: unknown };
  return candidate.code === 'no_matching_copy' || candidate.kind === 'no_matching_copy';
}

function putLatest(task: PendingEntityMutation): void {
  const key = keyOf(task);
  const existing = pending.get(key);
  if (existing && existing.updatedAt > task.updatedAt) return;
  pending.set(key, task);
}

function applyOptimistic(task: PendingEntityMutation): void {
  if (!task.entityId) return;
  const player = usePlayerStore.getState();
  if (task.operation === 'star') {
    player.setStarredOverride(task.entityId, Boolean(task.value), task.targetServerId);
  } else {
    player.setUserRatingOverride(task.entityId, Number(task.value), task.targetServerId);
  }
}

function schedule(key: string, delayMs: number): void {
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    void flushPendingEntityMutations();
  }, delayMs));
}

function partialFailureNotice(): void {
  showToast(i18n.t('entityRating.fanoutPartial'), 5000, 'warning');
}

async function execute(task: PendingEntityMutation): Promise<void> {
  if (!task.entityId) return;
  if (task.operation === 'star') {
    const meta = { serverId: task.targetServerId };
    if (task.value) await star(task.entityId, task.entityType === 'track' ? 'song' : task.entityType, meta);
    else await unstar(task.entityId, task.entityType === 'track' ? 'song' : task.entityType, meta);
  } else {
    await setRatingForServer(task.targetServerId, task.entityId, Number(task.value));
  }
}

function patchSuccessfulUi(task: PendingEntityMutation): void {
  if (!task.entityId || task.entityType !== 'track') return;
  const patch = task.operation === 'star'
    ? { starred: task.value ? new Date().toISOString() : undefined }
    : { userRating: Number(task.value) };
  patchCachedTrack(task.targetServerId, task.entityId, patch);
  usePlayerStore.setState(state => {
    const currentTrack = state.currentTrack;
    const currentServerId = currentTrack?.serverId ?? state.queueServerId ?? '';
    if (!currentTrack || currentTrack.id !== task.entityId || currentServerId !== task.targetServerId) return {};
    return { currentTrack: { ...currentTrack, ...patch } };
  });
}

async function runConcrete(key: string, task: PendingEntityMutation): Promise<void> {
  if (running.has(key) || !isOnline(task.targetServerId)) return;
  running.add(key);
  try {
    let current: PendingEntityMutation | undefined = task;
    while (current && current.resolution === 'resolved' && isOnline(current.targetServerId)) {
      if (isPermanentUnsupported(current)) {
        if (pending.get(key) === current) pending.delete(key);
        persist();
        partialFailureNotice();
        current = pending.get(key);
        continue;
      }
      try {
        await execute(current);
        if (pending.get(key) === current) {
          pending.delete(key);
          patchSuccessfulUi(current);
          persist();
        }
      } catch (error) {
        if (pending.get(key) !== current) {
          current = pending.get(key);
          continue;
        }
        if (isPermanentUnsupported(current, error)) {
          pending.delete(key);
          if (current.entityType !== 'track') {
            useAuthStore.getState().setEntityRatingSupport(current.targetServerId, 'track_only');
          }
          partialFailureNotice();
          persist();
          current = pending.get(key);
          continue;
        }
        const next = { ...current, attempts: current.attempts + 1 };
        pending.set(key, next);
        persist();
        schedule(key, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, next.attempts - 1)));
        break;
      }
      current = pending.get(key);
    }
  } finally {
    running.delete(key);
  }
}

async function resolveDeferredForServer(serverId: string): Promise<void> {
  const deferred = [...pending.entries()].filter(([, task]) =>
    task.resolution === 'awaiting_index' && task.targetServerId === serverId);
  if (deferred.length === 0) return;
  const targetScope = mutationScope().find(source => source.serverId === serverId);
  if (!targetScope || targetScope.readiness !== 'ready') return;

  const resolved = new Map<string, PendingEntityMutation>();
  for (const [oldKey, task] of deferred) {
    let sources;
    try {
      sources = await libraryResolveEntitySources(task.anchorServerId, {
        entityType: task.entityType,
        anchorServerId: task.anchorServerId,
        anchorId: task.anchorId,
        scopes: targetScope.pairs,
      });
    } catch (error) {
      if (isPermanentNoMatch(error) && pending.get(oldKey) === task) {
        pending.delete(oldKey);
      }
      continue;
    }
    if (pending.get(oldKey) !== task) continue;
    const source = sources.find(candidate => candidate.serverId === serverId);
    if (source) {
      pending.delete(oldKey);
      const concrete: PendingEntityMutation = {
        ...task,
        entityId: source.id,
        resolution: 'resolved',
      };
      const concreteKey = resolvedKey(concrete);
      const existing = resolved.get(concreteKey) ?? pending.get(concreteKey);
      if (!existing || concrete.updatedAt >= existing.updatedAt) {
        resolved.set(concreteKey, concrete);
      }
    }
  }
  for (const task of resolved.values()) {
    putLatest(task);
    applyOptimistic(task);
  }
  persist();
}

export async function flushPendingEntityMutations(serverId?: string): Promise<void> {
  restore();
  const readyServers = mutationScope()
    .filter(source => source.readiness === 'ready' && (!serverId || source.serverId === serverId))
    .map(source => source.serverId);
  for (const readyServerId of readyServers) await resolveDeferredForServer(readyServerId);

  const concrete = [...pending.entries()].filter(([, task]) =>
    task.resolution === 'resolved' && (!serverId || task.targetServerId === serverId));
  for (let i = 0; i < concrete.length; i += MAX_CONCURRENT) {
    await Promise.all(concrete.slice(i, i + MAX_CONCURRENT).map(([key, task]) => runConcrete(key, task)));
  }
}

async function enqueueEntityMutation(args: {
  entityType: PendingEntityType;
  anchorServerId: string;
  anchorId: string;
  operation: PendingEntityOperation;
  value: boolean | number;
}): Promise<void> {
  restore();
  const updatedAt = nextUpdatedAt();
  const scope = mutationScope();
  for (const target of scope) {
    putLatest({
      targetServerId: target.serverId,
      entityType: args.entityType,
      anchorServerId: args.anchorServerId,
      anchorId: args.anchorId,
      operation: args.operation,
      value: args.value,
      resolution: 'awaiting_index',
      updatedAt,
      attempts: 0,
    });
  }
  persist();

  const readyPairs = scope.filter(source => source.readiness === 'ready').flatMap(source => source.pairs);
  if (readyPairs.length > 0) {
    try {
      const sources = await libraryResolveEntitySources(args.anchorServerId, {
        entityType: args.entityType,
        anchorServerId: args.anchorServerId,
        anchorId: args.anchorId,
        scopes: readyPairs,
      });
      const sourceByServer = new Map(sources.map(source => [source.serverId, source]));
      for (const target of scope.filter(source => source.readiness === 'ready')) {
        const deferred: PendingEntityMutation = {
          targetServerId: target.serverId,
          entityType: args.entityType,
          anchorServerId: args.anchorServerId,
          anchorId: args.anchorId,
          operation: args.operation,
          value: args.value,
          resolution: 'awaiting_index',
          updatedAt,
          attempts: 0,
        };
        const oldKey = deferredKey(deferred);
        if (pending.get(oldKey)?.updatedAt !== updatedAt) continue;
        const source = sourceByServer.get(target.serverId);
        if (!source) continue;
        pending.delete(oldKey);
        const concrete: PendingEntityMutation = {
          ...deferred,
          entityId: source.id,
          resolution: 'resolved',
        };
        putLatest(concrete);
        applyOptimistic(concrete);
      }
      persist();
    } catch (error) {
      if (isPermanentNoMatch(error)) {
        for (const target of scope.filter(source => source.readiness === 'ready')) {
          const key = deferredKey({
            targetServerId: target.serverId,
            entityType: args.entityType,
            anchorServerId: args.anchorServerId,
            anchorId: args.anchorId,
            operation: args.operation,
          });
          if (pending.get(key)?.updatedAt === updatedAt) pending.delete(key);
        }
        persist();
      }
      /* Other failures leave durable deferred rows for the next lifecycle trigger. */
    }
  }
  await flushPendingEntityMutations();
}

function defaultAnchorServerId(serverId?: string): string {
  return serverId
    ?? usePlayerStore.getState().currentTrack?.serverId
    ?? useAuthStore.getState().activeServerId
    ?? '';
}

export function queueEntityStar(
  entityType: PendingEntityType,
  id: string,
  starred: boolean,
  serverId?: string,
): void {
  const anchorServerId = defaultAnchorServerId(serverId);
  if (!anchorServerId) return;
  usePlayerStore.getState().setStarredOverride(id, starred, anchorServerId);
  void enqueueEntityMutation({ entityType, anchorServerId, anchorId: id, operation: 'star', value: starred });
}

export function queueEntityRating(
  entityType: PendingEntityType,
  id: string,
  rating: number,
  serverId?: string,
): void {
  const anchorServerId = defaultAnchorServerId(serverId);
  if (!anchorServerId) return;
  usePlayerStore.getState().setUserRatingOverride(id, rating, anchorServerId);
  void enqueueEntityMutation({ entityType, anchorServerId, anchorId: id, operation: 'rating', value: rating });
}

export function queueSongStar(id: string, starred: boolean, serverId?: string): void {
  queueEntityStar('track', id, starred, serverId);
}

export function queueSongRating(id: string, rating: number, serverId?: string): void {
  queueEntityRating('track', id, rating, serverId);
}

export function discardPendingEntityMutationsForServer(serverId: string): void {
  restore();
  const discarded = [...pending.entries()].filter(([, task]) =>
    task.targetServerId === serverId || task.anchorServerId === serverId);
  if (discarded.length === 0) return;
  for (const [key] of discarded) {
    pending.delete(key);
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
  }
  persist();
  showToast(i18n.t('entityRating.pendingDiscarded'), 5000, 'warning');
}

export function initPendingEntityMutationSync(): () => void {
  restore();
  if (listenersArmed || typeof window === 'undefined') {
    void flushPendingEntityMutations();
    return () => {};
  }
  listenersArmed = true;
  const onFocus = () => { void flushPendingEntityMutations(); };
  window.addEventListener('focus', onFocus);
  const unsubscribeLibrary = useLibraryIndexStore.subscribe((state, previous) => {
    const serverIds = useAuthStore.getState().servers.map(server => server.id);
    for (const serverId of serverIds) {
      const key = resolveIndexKey(serverId);
      const becameOnline = state.connectionByServer[key] === 'online'
        && previous.connectionByServer[key] !== 'online';
      const becameReady = state.statusByServer[key]?.syncPhase === 'ready'
        && previous.statusByServer[key]?.syncPhase !== 'ready';
      if (becameOnline || becameReady) void flushPendingEntityMutations(serverId);
    }
  });
  void flushPendingEntityMutations();
  return () => {
    listenersArmed = false;
    window.removeEventListener('focus', onFocus);
    unsubscribeLibrary();
  };
}

registerEntityMutationBridge({ discardServer: discardPendingEntityMutationsForServer });

export function _getPendingEntityMutationsForTest(): PendingEntityMutation[] {
  return [...pending.values()];
}

export function _resetPendingStarSyncForTest(): void {
  _resetPendingEntityMutationMemoryForTest();
  if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
}

export function _resetPendingEntityMutationMemoryForTest(): void {
  pending.clear();
  running.clear();
  clock = 0;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}
