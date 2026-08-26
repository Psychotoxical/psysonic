import {
  AUTH_PERSISTENCE_KEY,
  readRawAuthServerProfileGroups,
  type RawAuthServerProfileGroup,
} from './navidromeCanonicalAuth';
import {
  NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY,
  NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY,
  readNavidromeCanonicalMigrationCheckpoint,
  writeNavidromeCanonicalMigrationCheckpoint,
} from './navidromeCanonicalCheckpoint';
import {
  rewriteNavidromeCanonicalFrontendState,
  type NavidromeCanonicalFrontendScope,
  type NavidromeCanonicalFrontendStorage,
} from './navidromeCanonicalFrontend';
import { classifyNavidromeCanonicalVersion } from './navidromeCanonicalVersion';

class StagedBackupStorage implements NavidromeCanonicalFrontendStorage {
  private readonly values = new Map<string, string>();

  constructor(stores: Record<string, unknown>) {
    for (const [key, value] of Object.entries(stores)) {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new Error(`invalid_backup_store:${key}`);
      this.values.set(key, serialized);
    }
  }

  get length(): number {
    return this.values.size;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  toStores(keys: readonly string[]): Record<string, unknown> {
    const stores: Record<string, unknown> = {};
    for (const key of keys) {
      const serialized = this.values.get(key);
      if (serialized !== undefined) stores[key] = JSON.parse(serialized) as unknown;
    }
    return stores;
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

/** Normalize allowlisted backup stores in memory before any live localStorage write. */
export function normalizeNavidromeCanonicalBackupStores(
  stores: Record<string, unknown>,
  storage: Storage = localStorage,
): Record<string, unknown> {
  const staged = new StagedBackupStorage(stores);
  const importedKeys = Object.keys(stores);
  const groups = Object.prototype.hasOwnProperty.call(stores, AUTH_PERSISTENCE_KEY)
    ? readRawAuthServerProfileGroups(staged)
    : readRawAuthServerProfileGroups(storage);
  const checkpoint = readNavidromeCanonicalMigrationCheckpoint(storage);
  for (const group of groups) {
    const saved = checkpoint?.servers[group.serverIndexKey];
    if (saved?.phase !== 'ready' || !saved.checkedVersion) continue;
    if (classifyNavidromeCanonicalVersion({
      type: 'navidrome',
      serverVersion: saved.checkedVersion,
    }) !== 'canonical') continue;
    rewriteNavidromeCanonicalFrontendState(frontendScope(group, groups), staged);
  }

  return staged.toStores(importedKeys);
}

export function armNavidromeCanonicalBackupImport(storage: Storage = localStorage): void {
  storage.setItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY, '1');
  if (storage.getItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY) !== '1') {
    throw new Error('Could not persist canonical migration bootstrap lock for backup import');
  }
}

export function disarmNavidromeCanonicalBackupImport(storage: Storage = localStorage): void {
  storage.removeItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY);
  if (storage.getItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY) !== null) {
    throw new Error('Could not clear canonical migration bootstrap lock after backup import failure');
  }
}

export function captureNavidromeCanonicalBackupRecoveryState(
  storage: Storage = localStorage,
): Record<string, string | null> {
  return {
    [NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY]: storage.getItem(
      NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY,
    ),
  };
}

export function restoreNavidromeCanonicalBackupRecoveryState(
  snapshot: Record<string, string | null>,
  storage: Storage = localStorage,
): void {
  const previous = snapshot[NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY] ?? null;
  if (previous === null) storage.removeItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY);
  else storage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, previous);
  if (storage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY) !== previous) {
    throw new Error('Could not restore canonical migration checkpoint after backup recovery');
  }
}

export type NavidromeCanonicalDatabaseImportPlan = {
  serverIds: string[];
  canonicalServerIds: string[];
  rollbackCheckpoint: () => void;
};

/** Remove stale ready records before an imported database can become active. */
export function prepareNavidromeCanonicalDatabaseImport(
  importedStores?: Record<string, unknown>,
  storage: Storage = localStorage,
): NavidromeCanonicalDatabaseImportPlan {
  const previousRaw = storage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY);
  const checkpoint = readNavidromeCanonicalMigrationCheckpoint(storage);
  const importedStorage = importedStores ? new StagedBackupStorage(importedStores) : null;
  const importedAuthIsAuthoritative = Boolean(
    importedStorage
      && importedStores
      && Object.prototype.hasOwnProperty.call(importedStores, AUTH_PERSISTENCE_KEY),
  );
  const groups = importedAuthIsAuthoritative
    ? readRawAuthServerProfileGroups(importedStorage!)
    : readRawAuthServerProfileGroups(storage);
  const serverIds = groups.map(group => group.serverIndexKey);
  const serverIdSet = new Set(serverIds);
  const canonicalServerIds = Object.entries(checkpoint?.servers ?? {})
    .filter(([serverId, saved]) => (!importedAuthIsAuthoritative || serverIdSet.has(serverId))
      && saved.phase === 'ready'
      && saved.checkedVersion
      && classifyNavidromeCanonicalVersion({
        type: 'navidrome',
        serverVersion: saved.checkedVersion,
    }) === 'canonical')
    .map(([serverId]) => serverId);

  if (importedAuthIsAuthoritative || serverIds.length > 0 || canonicalServerIds.length > 0) {
    const now = Date.now();
    const servers = importedAuthIsAuthoritative
      ? Object.fromEntries(Object.entries(checkpoint?.servers ?? {}).filter(([serverId]) => serverIdSet.has(serverId)))
      : { ...(checkpoint?.servers ?? {}) };
    for (const serverId of canonicalServerIds) delete servers[serverId];
    for (const serverId of serverIds) {
      const previous = checkpoint?.servers[serverId];
      servers[serverId] = {
        sourceVersion: previous?.sourceVersion ?? null,
        checkedVersion: null,
        canonicalVersion: 1,
        phase: 'pending',
        step: 'backup-import',
        cursorRowid: 0,
        upperRowid: 0,
        cursorKey: null,
        upperKey: null,
        startedAt: previous?.startedAt ?? now,
        updatedAt: now,
        localCompletedAt: null,
        syncCompletedAt: null,
        lastError: null,
      };
    }
    writeNavidromeCanonicalMigrationCheckpoint({ version: 1, servers }, storage);
  }

  return {
    serverIds,
    canonicalServerIds,
    rollbackCheckpoint: () => {
      if (previousRaw === null) storage.removeItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY);
      else storage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, previousRaw);
      if (storage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY) !== previousRaw) {
        throw new Error('Could not restore canonical migration checkpoint after backup failure');
      }
    },
  };
}
