import { beforeEach, describe, expect, it } from 'vitest';
import { NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY } from '@/lib/server/navidromeCanonicalCheckpointStatus';
import { useAuthStore } from './authStore';

describe('authStore canonical migration persistence fence', () => {
  beforeEach(() => localStorage.clear());

  it('does not rewrite the auth blob from a delayed mutation while migration is active', () => {
    const original = JSON.stringify({ state: { skipStarManualSkipCountsByKey: { stale: 1 } }, version: 1 });
    localStorage.setItem('psysonic-auth', original);
    localStorage.setItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY, '1');

    useAuthStore.setState({ crossfadeEnabled: !useAuthStore.getState().crossfadeEnabled });

    expect(localStorage.getItem('psysonic-auth')).toBe(original);
  });
});
