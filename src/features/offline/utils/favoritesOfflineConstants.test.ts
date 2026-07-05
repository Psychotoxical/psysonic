import { describe, expect, it } from 'vitest';
import { FAVORITES_OFFLINE_JOB_ID } from '@/features/offline/utils/favoritesOfflineConstants';

describe('favoritesOfflineConstants', () => {
  it('uses a stable virtual job id', () => {
    expect(FAVORITES_OFFLINE_JOB_ID).toBe('__favorites__');
  });
});
