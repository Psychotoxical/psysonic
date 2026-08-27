import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalNavidromeId } from '@/lib/server/navidromeCanonicalId';
import {
  normalizeNavidromeExternalId,
} from '@/lib/server/navidromeCanonicalExternalId';
import {
  NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY,
  NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY,
} from '@/lib/server/navidromeCanonicalCheckpointStatus';

const PROFILE_ID = '123e4567-e89b-42d3-a456-426614174000';
const LEGACY_ID = '550e8400-e29b-41d4-a716-446655440000';

function seed(phase: 'ready' | 'legacy' | 'pending'): void {
  localStorage.setItem('psysonic-auth', JSON.stringify({
    state: {
      activeServerId: PROFILE_ID,
      servers: [{ id: PROFILE_ID, url: 'https://music.test' }],
    },
  }));
  localStorage.setItem(NAVIDROME_CANONICAL_MIGRATION_CHECKPOINT_KEY, JSON.stringify({
    version: 1,
    servers: {
      'music.test': {
        canonicalVersion: 1,
        phase,
        checkedVersion: phase === 'ready' ? '0.64.0' : null,
      },
    },
  }));
}

describe('normalizeNavidromeExternalId', () => {
  beforeEach(() => localStorage.clear());

  it('canonicalizes old durable IDs only after the server checkpoint is ready', () => {
    seed('ready');
    expect(normalizeNavidromeExternalId(PROFILE_ID, LEGACY_ID))
      .toBe(canonicalNavidromeId(LEGACY_ID));
  });

  it('preserves IDs for a legacy server', () => {
    seed('legacy');
    expect(normalizeNavidromeExternalId(PROFILE_ID, LEGACY_ID)).toBe(LEGACY_ID);
  });

  it('rejects external ingress while migration is pending', () => {
    seed('pending');
    expect(() => normalizeNavidromeExternalId(PROFILE_ID, LEGACY_ID))
      .toThrow('canonical_migration_not_ready:music.test');
  });

  it('rejects external ingress as soon as the bootstrap lock is active', () => {
    seed('legacy');
    localStorage.setItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY, '1');

    expect(() => normalizeNavidromeExternalId(PROFILE_ID, LEGACY_ID))
      .toThrow('canonical_migration_active');
  });
});
