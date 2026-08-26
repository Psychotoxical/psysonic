export const NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY =
  'psysonic-navidrome-canonical-id-migration-v1';

export type NavidromeCanonicalCheckpointStatus =
  | 'absent'
  | 'ready'
  | 'legacy'
  | 'pending'
  | 'invalid';

type CheckpointStorage = Pick<Storage, 'getItem'>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the migration readiness needed by lower-layer consumers without hydrating app stores. */
export function navidromeCanonicalCheckpointStatus(
  serverIndexKey: string,
  storage: CheckpointStorage = localStorage,
): NavidromeCanonicalCheckpointStatus {
  const raw = storage.getItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY);
  if (raw === null) return 'absent';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return 'invalid';
  }
  if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.servers)) return 'invalid';
  const checkpoint = parsed.servers[serverIndexKey];
  if (checkpoint === undefined) return 'absent';
  if (!isObject(checkpoint) || checkpoint.canonicalVersion !== 1 || typeof checkpoint.phase !== 'string') {
    return 'invalid';
  }
  if (checkpoint.phase === 'ready') {
    return typeof checkpoint.checkedVersion === 'string' && checkpoint.checkedVersion.length > 0
      ? 'ready'
      : 'invalid';
  }
  if (checkpoint.phase === 'legacy' || checkpoint.phase === 'not-applicable') return 'legacy';
  return 'pending';
}
