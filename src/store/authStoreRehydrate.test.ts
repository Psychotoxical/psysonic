import { beforeEach, describe, expect, it } from 'vitest';
import { computeAuthStoreRehydration } from './authStoreRehydrate';
import { useAuthStore } from './authStore';
import type { AuthState } from './authStoreTypes';
import { resetAuthStore } from '@/test/helpers/storeReset';

describe('computeAuthStoreRehydration — queueDurationDisplayMode', () => {
  beforeEach(() => {
    resetAuthStore();
  });

  it.each(['invalid_mode', 123, null, undefined] as const)(
    'maps corrupted value %j back to "total"',
    (corrupt) => {
      const base = useAuthStore.getState();
      const patch = computeAuthStoreRehydration({
        ...base,
        queueDurationDisplayMode: corrupt as never,
      });
      expect(patch.queueDurationDisplayMode).toBe('total');
    },
  );

  it('maps a rehydrated payload without the key back to "total"', () => {
    const base = useAuthStore.getState();
    const { queueDurationDisplayMode: _drop, ...without } = base;
    const patch = computeAuthStoreRehydration(without as AuthState);
    expect(patch.queueDurationDisplayMode).toBe('total');
  });

  it.each(['total', 'remaining', 'eta'] as const)(
    'does not overwrite a valid mode (%s)',
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

describe('computeAuthStoreRehydration — lyrics', () => {
  beforeEach(() => {
    resetAuthStore();
    localStorage.clear();
  });

  it('migrates legacy lyricsMode "lyricsplus" → youLyPlusEnabled true', () => {
    const base = useAuthStore.getState();
    const patch = computeAuthStoreRehydration({ ...base, lyricsMode: 'lyricsplus' } as AuthState);
    expect(patch.youLyPlusEnabled).toBe(true);
  });

  it('migrates legacy lyricsMode "standard" → youLyPlusEnabled false', () => {
    const base = useAuthStore.getState();
    const patch = computeAuthStoreRehydration({ ...base, lyricsMode: 'standard' } as AuthState);
    expect(patch.youLyPlusEnabled).toBe(false);
  });

  it('fresh install (no persisted state) keeps every source off — issue #810', () => {
    localStorage.removeItem('psysonic-auth');
    const patch = computeAuthStoreRehydration(useAuthStore.getState());
    // No migration: the all-off default must survive.
    expect(patch.lyricsSources).toBeUndefined();
  });

  it('upgrade from a build without lyricsSources migrates the old on-by-default set', () => {
    localStorage.setItem('psysonic-auth', JSON.stringify({ state: { lyricsServerFirst: true } }));
    const patch = computeAuthStoreRehydration(useAuthStore.getState());
    expect(patch.lyricsSources).toEqual([
      { id: 'server', enabled: true },
      { id: 'lrclib', enabled: true },
      { id: 'netease', enabled: false },
    ]);
  });

  it('clears startMinimizedToTray when tray icon is off', () => {
    const base = useAuthStore.getState();
    const patch = computeAuthStoreRehydration({
      ...base,
      startMinimizedToTray: true,
      showTrayIcon: false,
    });
    expect(patch.startMinimizedToTray).toBe(false);
  });
});
