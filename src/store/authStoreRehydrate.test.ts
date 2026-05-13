import { beforeEach, describe, expect, it } from 'vitest';
import { computeAuthStoreRehydration } from './authStoreRehydrate';
import { useAuthStore } from './authStore';
import type { AuthState } from './authStoreTypes';
import { resetAuthStore } from '@/test/helpers/storeReset';

describe('computeAuthStoreRehydration', () => {
  beforeEach(() => {
    resetAuthStore();
  });

  describe('queueDurationDisplayMode', () => {
    it.each(['invalid_mode', 123, null, undefined] as const)(
      'maps corrupted value %j to total',
      (corrupt) => {
        const base = useAuthStore.getState();
        const patch = computeAuthStoreRehydration({
          ...base,
          queueDurationDisplayMode: corrupt as never,
        });
        expect(patch.queueDurationDisplayMode).toBe('total');
      },
    );

    it('maps a rehydrated object without the key to total', () => {
      const base = useAuthStore.getState();
      const { queueDurationDisplayMode: _drop, ...without } = base;
      const patch = computeAuthStoreRehydration(without as AuthState);
      expect(patch.queueDurationDisplayMode).toBe('total');
    });

    it.each(['total', 'remaining', 'eta'] as const)(
      'does not overwrite valid mode %s',
      (mode) => {
        const base = useAuthStore.getState();
        const patch = computeAuthStoreRehydration({
          ...base,
          queueDurationDisplayMode: mode,
        });
        expect(patch.queueDurationDisplayMode).toBeUndefined();
      },
    );
  });
});
