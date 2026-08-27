import { beforeEach, describe, expect, it } from 'vitest';
import { NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY } from '@/lib/server/navidromeCanonicalCheckpointStatus';
import { persistShuffleModeSnapshot } from './shuffleModeStorage';

describe('persistShuffleModeSnapshot migration fence', () => {
  beforeEach(() => localStorage.clear());

  it('does not rewrite shuffle identity state while migration is active', () => {
    localStorage.setItem('psysonic_shuffle_mode', JSON.stringify({
      enabled: true,
      originalOrder: ['legacy-track'],
    }));
    localStorage.setItem(NAVIDROME_CANONICAL_BOOTSTRAP_LOCK_KEY, '1');

    persistShuffleModeSnapshot({ enabled: true, originalOrder: ['stale-track'] });

    expect(JSON.parse(localStorage.getItem('psysonic_shuffle_mode') ?? '{}')).toEqual({
      enabled: true,
      originalOrder: ['legacy-track'],
    });
  });
});
