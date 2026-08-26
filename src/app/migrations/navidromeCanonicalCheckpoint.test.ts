import { describe, expect, it } from 'vitest';
import {
  NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY,
  readNavidromeCanonicalMigrationCheckpoint,
  writeNavidromeCanonicalMigrationCheckpoint,
  type NavidromeCanonicalMigrationCheckpointV1,
  type NavidromeCanonicalCheckpointStorage,
} from './navidromeCanonicalCheckpoint';

function checkpoint(): NavidromeCanonicalMigrationCheckpointV1 {
  return {
    version: 1,
    servers: {
      'music.test': {
        sourceVersion: '0.64.0 (01234567)',
        checkedVersion: null,
        canonicalVersion: 1,
        phase: 'native',
        step: 'track',
        cursorRowid: 10,
        upperRowid: 100,
        cursorKey: null,
        upperKey: null,
        startedAt: 1,
        updatedAt: 2,
        localCompletedAt: null,
        syncCompletedAt: null,
        lastError: null,
      },
    },
  };
}

describe('Navidrome canonical migration checkpoint', () => {
  it('writes the whole value and returns a strictly decoded readback', () => {
    writeNavidromeCanonicalMigrationCheckpoint(checkpoint());
    expect(readNavidromeCanonicalMigrationCheckpoint()).toEqual(checkpoint());
  });

  it.each([
    '{not-json',
    JSON.stringify({ version: 1, servers: [], extra: true }),
    JSON.stringify({ version: 2, servers: {} }),
    JSON.stringify({
      ...checkpoint(),
      servers: { 'music.test': { ...checkpoint().servers['music.test'], phase: 'unknown' } },
    }),
    JSON.stringify({
      ...checkpoint(),
      servers: { 'music.test': { ...checkpoint().servers['music.test'], unexpected: true } },
    }),
  ])('throws for corrupt checkpoint %s', (raw) => {
    localStorage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, raw);
    expect(() => readNavidromeCanonicalMigrationCheckpoint()).toThrow();
  });

  it('throws when storage does not preserve the written value', () => {
    const values = new Map<string, string>();
    const storage: NavidromeCanonicalCheckpointStorage = {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => {
        const parsed = JSON.parse(value) as NavidromeCanonicalMigrationCheckpointV1;
        parsed.servers['music.test']!.cursorRowid += 1;
        values.set(key, JSON.stringify(parsed));
      },
    };

    expect(() => writeNavidromeCanonicalMigrationCheckpoint(checkpoint(), storage))
      .toThrow('readback mismatch');
  });

  it('throws when storage drops the whole-value write', () => {
    const storage: NavidromeCanonicalCheckpointStorage = {
      getItem: () => null,
      setItem: () => undefined,
    };

    expect(() => writeNavidromeCanonicalMigrationCheckpoint(checkpoint(), storage))
      .toThrow('readback mismatch');
  });
});
