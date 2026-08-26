import { NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY } from '@/lib/server/navidromeCanonicalCheckpointStatus';

export { NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY } from '@/lib/server/navidromeCanonicalCheckpointStatus';
export const NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY =
  'psysonic-navidrome-canonical-bootstrap-active-v1';

const CHECKPOINT_PHASES = [
  'legacy',
  'not-applicable',
  'pending',
  'native',
  'analysis',
  'cover',
  'frontend',
  'cleanup',
  'sync',
  'ready',
  'retryable',
  'blocked',
] as const;

export type NavidromeCanonicalMigrationPhase = typeof CHECKPOINT_PHASES[number];

export type NavidromeCanonicalMigrationServerCheckpointV1 = {
  sourceVersion: string | null;
  checkedVersion: string | null;
  canonicalVersion: 1;
  phase: NavidromeCanonicalMigrationPhase;
  step: string | null;
  cursorRowid: number;
  upperRowid: number;
  cursorKey: string | null;
  upperKey: string | null;
  startedAt: number;
  updatedAt: number;
  localCompletedAt: number | null;
  syncCompletedAt: number | null;
  lastError: string | null;
};

export type NavidromeCanonicalMigrationCheckpointV1 = {
  version: 1;
  servers: Record<string, NavidromeCanonicalMigrationServerCheckpointV1>;
};

export type NavidromeCanonicalCheckpointStorage = Pick<Storage, 'getItem' | 'setItem'>;

const SERVER_CHECKPOINT_KEYS = [
  'sourceVersion',
  'checkedVersion',
  'canonicalVersion',
  'phase',
  'step',
  'cursorRowid',
  'upperRowid',
  'cursorKey',
  'upperKey',
  'startedAt',
  'updatedAt',
  'localCompletedAt',
  'syncCompletedAt',
  'lastError',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every(key => typeof key === 'string' && expected.includes(key));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function decodeServerCheckpoint(
  value: unknown,
  serverIndexKey: string,
): NavidromeCanonicalMigrationServerCheckpointV1 {
  if (!isPlainObject(value) || !hasExactKeys(value, SERVER_CHECKPOINT_KEYS)) {
    throw new Error(`Invalid canonical migration checkpoint for ${serverIndexKey}`);
  }
  if (!isNullableString(value.sourceVersion)
    || !isNullableString(value.checkedVersion)
    || value.canonicalVersion !== 1
    || !CHECKPOINT_PHASES.includes(value.phase as NavidromeCanonicalMigrationPhase)
    || !isNullableString(value.step)
    || !isNonNegativeSafeInteger(value.cursorRowid)
    || !isNonNegativeSafeInteger(value.upperRowid)
    || !isNullableString(value.cursorKey)
    || !isNullableString(value.upperKey)
    || !isNonNegativeSafeInteger(value.startedAt)
    || !isNonNegativeSafeInteger(value.updatedAt)
    || !(value.localCompletedAt === null || isNonNegativeSafeInteger(value.localCompletedAt))
    || !(value.syncCompletedAt === null || isNonNegativeSafeInteger(value.syncCompletedAt))
    || !isNullableString(value.lastError)) {
    throw new Error(`Invalid canonical migration checkpoint for ${serverIndexKey}`);
  }
  return {
    sourceVersion: value.sourceVersion,
    checkedVersion: value.checkedVersion,
    canonicalVersion: 1,
    phase: value.phase as NavidromeCanonicalMigrationPhase,
    step: value.step,
    cursorRowid: value.cursorRowid,
    upperRowid: value.upperRowid,
    cursorKey: value.cursorKey,
    upperKey: value.upperKey,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    localCompletedAt: value.localCompletedAt,
    syncCompletedAt: value.syncCompletedAt,
    lastError: value.lastError,
  };
}

export function decodeNavidromeCanonicalMigrationCheckpoint(
  value: unknown,
): NavidromeCanonicalMigrationCheckpointV1 {
  if (!isPlainObject(value) || !hasExactKeys(value, ['version', 'servers'])
    || value.version !== 1 || !isPlainObject(value.servers)) {
    throw new Error('Invalid canonical migration checkpoint');
  }
  const servers = value.servers;
  const serverEntries = Reflect.ownKeys(servers).map((key) => {
    if (typeof key !== 'string' || !key || key.trim() !== key) {
      throw new Error('Invalid canonical migration checkpoint server key');
    }
    return [key, decodeServerCheckpoint(servers[key], key)] as const;
  });
  return { version: 1, servers: Object.fromEntries(serverEntries) };
}

export function readNavidromeCanonicalMigrationCheckpoint(
  storage: NavidromeCanonicalCheckpointStorage = localStorage,
): NavidromeCanonicalMigrationCheckpointV1 | null {
  const raw = storage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Malformed canonical migration checkpoint JSON');
  }
  return decodeNavidromeCanonicalMigrationCheckpoint(parsed);
}

function deeplyEquivalent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => deeplyEquivalent(value, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key)
      && deeplyEquivalent(left[key], right[key]));
}

export function writeNavidromeCanonicalMigrationCheckpoint(
  checkpoint: NavidromeCanonicalMigrationCheckpointV1,
  storage: NavidromeCanonicalCheckpointStorage = localStorage,
): void {
  const validated = decodeNavidromeCanonicalMigrationCheckpoint(checkpoint);
  storage.setItem(
    NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY,
    JSON.stringify(validated),
  );
  const readBack = readNavidromeCanonicalMigrationCheckpoint(storage);
  if (!readBack || !deeplyEquivalent(validated, readBack)) {
    throw new Error('Canonical migration checkpoint readback mismatch');
  }
}
