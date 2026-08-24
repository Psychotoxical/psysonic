interface OfflineTrackOperation {
  serverIndexKey: string;
  trackId: string;
}

interface OfflineServerMaintenanceBarrier {
  promise: Promise<void>;
  keys: Set<string>;
}

export interface OfflineServerOperationLease {
  (): void;
  readonly serverIndexKey: string;
  isActive: () => boolean;
}

const trackDeletionBarriers = new Map<string, Promise<void>>();
const trackCleanupBarriers = new Map<string, Promise<void>>();
const trackDeletionEpochs = new Map<string, number>();
const activeTrackTransfers = new Map<string, number>();
const trackTransferIdleWaiters = new Map<string, Set<() => void>>();
const activeServerTransfers = new Map<string, number>();
const serverTransferIdleWaiters = new Map<string, Set<() => void>>();
const serverMaintenanceBarriers = new Map<string, OfflineServerMaintenanceBarrier>();
const sourceGenerations = new Map<string, number>();
const serverKeyRemaps = new Map<string, string>();

export function resolveOfflineServerOperationKey(serverIndexKey: string): string {
  let current = serverIndexKey;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const next = serverKeyRemaps.get(current);
    if (!next) return current;
    current = next;
  }
  return current;
}

export function registerOfflineServerKeyRemaps(
  remaps: Iterable<{ oldKey: string; newKey: string }>,
): void {
  for (const { oldKey, newKey } of remaps) {
    if (!oldKey || !newKey || oldKey === newKey) continue;
    const oldResolved = resolveOfflineServerOperationKey(oldKey);
    const newResolvedBefore = resolveOfflineServerOperationKey(newKey);
    const activeMaintenance = serverMaintenanceBarriers.get(newResolvedBefore)
      ?? serverMaintenanceBarriers.get(oldResolved);
    const aliases = [...serverKeyRemaps.keys()].filter(
      key => resolveOfflineServerOperationKey(key) === oldResolved,
    );
    serverKeyRemaps.delete(newKey);
    for (const alias of new Set([oldKey, oldResolved, ...aliases])) {
      if (alias !== newKey) serverKeyRemaps.set(alias, newKey);
    }
    const newResolved = resolveOfflineServerOperationKey(newKey);
    if (activeMaintenance && !serverMaintenanceBarriers.has(newResolved)) {
      activeMaintenance.keys.add(newResolved);
      serverMaintenanceBarriers.set(newResolved, activeMaintenance);
    }
  }
}

function trackKey(serverIndexKey: string, trackId: string): string {
  return `${resolveOfflineServerOperationKey(serverIndexKey)}:${trackId}`;
}

function sourceKey(serverIndexKey: string, kind: string, sourceId: string): string {
  return `${resolveOfflineServerOperationKey(serverIndexKey)}:${kind}:${sourceId}`;
}

export async function waitForOfflineTrackDeletion(
  serverIndexKey: string,
  trackId: string,
): Promise<void> {
  await trackDeletionBarriers.get(trackKey(serverIndexKey, trackId));
}

export function getOfflineTrackDeletionEpoch(
  serverIndexKey: string,
  trackId: string,
): number {
  return trackDeletionEpochs.get(trackKey(serverIndexKey, trackId)) ?? 0;
}

export async function beginOfflineServerOperation(
  serverIndexKey: string,
): Promise<OfflineServerOperationLease> {
  const resolvedServerIndexKey = resolveOfflineServerOperationKey(serverIndexKey);
  const maintenance = serverMaintenanceBarriers.get(resolvedServerIndexKey);
  if (maintenance) {
    await maintenance.promise;
    return beginOfflineServerOperation(serverIndexKey);
  }
  activeServerTransfers.set(
    resolvedServerIndexKey,
    (activeServerTransfers.get(resolvedServerIndexKey) ?? 0) + 1,
  );
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const serverRemaining = (activeServerTransfers.get(resolvedServerIndexKey) ?? 1) - 1;
    if (serverRemaining > 0) activeServerTransfers.set(resolvedServerIndexKey, serverRemaining);
    else {
      activeServerTransfers.delete(resolvedServerIndexKey);
      const waiters = serverTransferIdleWaiters.get(resolvedServerIndexKey);
      serverTransferIdleWaiters.delete(resolvedServerIndexKey);
      for (const resolve of waiters ?? []) resolve();
    }
  };
  return Object.assign(release, {
    serverIndexKey: resolvedServerIndexKey,
    isActive: () => !released,
  });
}

async function acquireOfflineServerOperation(
  serverIndexKey: string,
  lease?: OfflineServerOperationLease,
): Promise<() => void> {
  if (!lease) return beginOfflineServerOperation(serverIndexKey);
  if (
    !lease.isActive()
    || resolveOfflineServerOperationKey(lease.serverIndexKey)
      !== resolveOfflineServerOperationKey(serverIndexKey)
  ) {
    throw new Error('offline server operation lease does not match the requested server');
  }
  return () => {};
}

export async function beginOfflineTrackTransfer(
  serverIndexKey: string,
  trackId: string,
  serverLease?: OfflineServerOperationLease,
): Promise<() => void> {
  const finishServerOperation = await acquireOfflineServerOperation(serverIndexKey, serverLease);
  const key = trackKey(serverIndexKey, trackId);
  const blocker = trackDeletionBarriers.get(key) ?? trackCleanupBarriers.get(key);
  if (blocker) {
    finishServerOperation();
    await blocker;
    return beginOfflineTrackTransfer(serverIndexKey, trackId, serverLease);
  }
  activeTrackTransfers.set(key, (activeTrackTransfers.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeTrackTransfers.get(key) ?? 1) - 1;
    if (remaining > 0) activeTrackTransfers.set(key, remaining);
    else {
      activeTrackTransfers.delete(key);
      const waiters = trackTransferIdleWaiters.get(key);
      trackTransferIdleWaiters.delete(key);
      for (const resolve of waiters ?? []) resolve();
    }
    finishServerOperation();
  };
}

export function waitForOfflineTrackTransfers(
  serverIndexKey: string,
  trackId: string,
): Promise<void> {
  const key = trackKey(serverIndexKey, trackId);
  if (!activeTrackTransfers.has(key)) return Promise.resolve();
  return new Promise(resolve => {
    const waiters = trackTransferIdleWaiters.get(key) ?? new Set<() => void>();
    waiters.add(resolve);
    trackTransferIdleWaiters.set(key, waiters);
  });
}

function waitForOfflineServerTransfers(serverIndexKey: string): Promise<void> {
  if (!activeServerTransfers.has(serverIndexKey)) return Promise.resolve();
  return new Promise(resolve => {
    const waiters = serverTransferIdleWaiters.get(serverIndexKey) ?? new Set<() => void>();
    waiters.add(resolve);
    serverTransferIdleWaiters.set(serverIndexKey, waiters);
  });
}

export async function runOfflineServerMaintenance<T>(
  serverIndexKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  const resolvedServerIndexKey = resolveOfflineServerOperationKey(serverIndexKey);
  const active = serverMaintenanceBarriers.get(resolvedServerIndexKey);
  if (active) {
    await active.promise;
    return runOfflineServerMaintenance(serverIndexKey, operation);
  }

  let finishMaintenance!: () => void;
  const maintenancePromise = new Promise<void>(resolve => {
    finishMaintenance = resolve;
  });
  const maintenanceBarrier: OfflineServerMaintenanceBarrier = {
    promise: maintenancePromise,
    keys: new Set([resolvedServerIndexKey]),
  };
  serverMaintenanceBarriers.set(resolvedServerIndexKey, maintenanceBarrier);
  try {
    await waitForOfflineServerTransfers(resolvedServerIndexKey);
    return await operation();
  } finally {
    for (const key of maintenanceBarrier.keys) {
      if (serverMaintenanceBarriers.get(key) === maintenanceBarrier) {
        serverMaintenanceBarriers.delete(key);
      }
    }
    finishMaintenance();
  }
}

export async function runOfflineServerMaintenanceBatch<T>(
  serverIndexKeys: Iterable<string>,
  operation: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(
    [...serverIndexKeys].filter(Boolean).map(resolveOfflineServerOperationKey),
  )].sort();
  const run = (index: number): Promise<T> => index >= keys.length
    ? operation()
    : runOfflineServerMaintenance(keys[index], () => run(index + 1));
  return run(0);
}

export async function runOfflineTrackDeletionBatch(
  targets: OfflineTrackOperation[],
  operation: () => Promise<void>,
  serverLeases: OfflineServerOperationLease[] = [],
): Promise<void> {
  const keys = [...new Set(targets.map(target => trackKey(
    target.serverIndexKey,
    target.trackId,
  )))];
  const active = [...new Set(keys.flatMap(key => [
    trackDeletionBarriers.get(key),
    trackCleanupBarriers.get(key),
  ]).filter(Boolean))];
  if (active.length > 0) {
    await Promise.all(active);
    return runOfflineTrackDeletionBatch(targets, operation, serverLeases);
  }

  const finishServerOperations = await Promise.all(
    [...new Set(targets.map(target => resolveOfflineServerOperationKey(target.serverIndexKey)))]
      .map(serverIndexKey => acquireOfflineServerOperation(
        serverIndexKey,
        serverLeases.find(lease => (
          resolveOfflineServerOperationKey(lease.serverIndexKey) === serverIndexKey
        )),
      )),
  );
  const newlyActive = [...new Set(keys.flatMap(key => [
    trackDeletionBarriers.get(key),
    trackCleanupBarriers.get(key),
  ]).filter(Boolean))];
  if (newlyActive.length > 0) {
    for (const finish of finishServerOperations) finish();
    await Promise.all(newlyActive);
    return runOfflineTrackDeletionBatch(targets, operation, serverLeases);
  }

  let begin!: () => void;
  const start = new Promise<void>(resolve => {
    begin = resolve;
  });
  const deletion = (async () => {
    await start;
    await operation();
  })();
  for (const key of keys) {
    trackDeletionEpochs.set(key, (trackDeletionEpochs.get(key) ?? 0) + 1);
    trackDeletionBarriers.set(key, deletion);
  }
  begin();
  try {
    await deletion;
  } finally {
    for (const key of keys) {
      if (trackDeletionBarriers.get(key) === deletion) trackDeletionBarriers.delete(key);
    }
    for (const finish of finishServerOperations) finish();
  }
}

export async function runOfflineTrackCleanup(
  serverIndexKey: string,
  trackId: string,
  operation: () => Promise<void>,
  serverLease?: OfflineServerOperationLease,
): Promise<void> {
  const key = trackKey(serverIndexKey, trackId);
  const activeOperation = trackDeletionBarriers.get(key) ?? trackCleanupBarriers.get(key);
  if (activeOperation) {
    await activeOperation;
    return runOfflineTrackCleanup(serverIndexKey, trackId, operation, serverLease);
  }

  const finishServerOperation = await acquireOfflineServerOperation(serverIndexKey, serverLease);
  const newlyActiveOperation = trackDeletionBarriers.get(key) ?? trackCleanupBarriers.get(key);
  if (newlyActiveOperation) {
    finishServerOperation();
    await newlyActiveOperation;
    return runOfflineTrackCleanup(serverIndexKey, trackId, operation, serverLease);
  }

  let finishCleanup!: () => void;
  const cleanupBarrier = new Promise<void>(resolve => {
    finishCleanup = resolve;
  });
  trackCleanupBarriers.set(key, cleanupBarrier);
  try {
    await waitForOfflineTrackTransfers(serverIndexKey, trackId);
    await operation();
  } finally {
    if (trackCleanupBarriers.get(key) === cleanupBarrier) trackCleanupBarriers.delete(key);
    finishCleanup();
    finishServerOperation();
  }
}

export function getOfflineSourceGeneration(
  serverIndexKey: string,
  kind: string,
  sourceId: string,
): number {
  return sourceGenerations.get(sourceKey(serverIndexKey, kind, sourceId)) ?? 0;
}

export function invalidateOfflineSource(
  serverIndexKey: string,
  kind: string,
  sourceId: string,
): void {
  const key = sourceKey(serverIndexKey, kind, sourceId);
  sourceGenerations.set(key, (sourceGenerations.get(key) ?? 0) + 1);
}

export function beginOfflineSourceOperation(
  serverIndexKey: string,
  kind: string,
  sourceId: string,
): number {
  invalidateOfflineSource(serverIndexKey, kind, sourceId);
  return getOfflineSourceGeneration(serverIndexKey, kind, sourceId);
}
