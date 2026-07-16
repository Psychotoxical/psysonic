import { describe, expect, it } from 'vitest';
import {
  clearBecauseYouLikeCache,
  readBecauseYouLikeCache,
  writeBecauseYouLikeCache,
} from '@/features/home/store/becauseYouLikeCache';

describe('becauseYouLikeCache', () => {
  it('invalidates when music library filter version changes', () => {
    clearBecauseYouLikeCache();
    writeBecauseYouLikeCache({
      sourceKey: 'scope-1',
      filterVersion: 1,
      anchor: { id: 'a1', name: 'Artist' },
      recs: [{ id: 'alb-1', name: 'Album', artist: 'Artist', artistId: 'a1', songCount: 1, duration: 1 }],
    });
    expect(readBecauseYouLikeCache('scope-1', 1)?.recs).toHaveLength(1);
    expect(readBecauseYouLikeCache('scope-1', 2)).toBeNull();
  });

  it('invalidates when the browse scope fingerprint changes', () => {
    clearBecauseYouLikeCache();
    writeBecauseYouLikeCache({
      sourceKey: 'scope-a',
      filterVersion: 1,
      anchor: { id: 'a1', name: 'Artist' },
      recs: [{ id: 'alb-1', name: 'Album', artist: 'Artist', artistId: 'a1', songCount: 1, duration: 1 }],
    });
    expect(readBecauseYouLikeCache('scope-b', 1)).toBeNull();
  });
});
