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

describe('computeAuthStoreRehydration — discordCoverSource server-revival (PR #1299)', () => {
  const SENTINEL_KEY = 'psysonic-discord-server-cover-revival-v1';

  beforeEach(() => {
    resetAuthStore();
    localStorage.clear();
  });

  it('coerces a stale pre-#1246 "server" value to "none" exactly once', () => {
    const base = useAuthStore.getState();
    const patch = computeAuthStoreRehydration({ ...base, discordCoverSource: 'server' } as AuthState);
    expect(patch.discordCoverSource).toBe('none');
    expect(localStorage.getItem(SENTINEL_KEY)).toBe('1');
  });

  it('does not coerce "server" once the sentinel is already set (post-revival user choice)', () => {
    localStorage.setItem(SENTINEL_KEY, '1');
    const base = useAuthStore.getState();
    const patch = computeAuthStoreRehydration({ ...base, discordCoverSource: 'server' } as AuthState);
    expect(patch.discordCoverSource).toBeUndefined();
  });

  it('sets the sentinel on first rehydrate even when the value is not "server"', () => {
    const base = useAuthStore.getState();
    computeAuthStoreRehydration({ ...base, discordCoverSource: 'none' } as AuthState);
    expect(localStorage.getItem(SENTINEL_KEY)).toBe('1');
  });

  it('does not touch "apple" or "none"', () => {
    const base = useAuthStore.getState();
    for (const source of ['apple', 'none'] as const) {
      const patch = computeAuthStoreRehydration({ ...base, discordCoverSource: source } as AuthState);
      expect(patch.discordCoverSource).toBeUndefined();
    }
  });
});

describe('computeAuthStoreRehydration — multi-server library scope', () => {
  beforeEach(() => {
    resetAuthStore();
    localStorage.clear();
  });

  it('selects the active server for legacy state and preserves stale folder selections', () => {
    const base = useAuthStore.getState();
    const servers = [
      { id: 'a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' },
      { id: 'b', name: 'B', url: 'https://b.test', username: 'u', password: 'p' },
    ];
    const patch = computeAuthStoreRehydration({
      ...base,
      servers,
      activeServerId: 'b',
      musicLibrarySelectionByServer: { b: ['offline-stale'] },
    } as AuthState);
    expect(patch.musicLibraryServerIds).toEqual(['b']);
    expect(patch.musicLibrarySelectionByServer).toEqual({ b: ['offline-stale'] });
  });

  it('sanitizes membership and folder maps using common server order', () => {
    const base = useAuthStore.getState();
    const servers = [
      { id: 'a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' },
      { id: 'b', name: 'B', url: 'https://b.test', username: 'u', password: 'p' },
    ];
    const patch = computeAuthStoreRehydration({
      ...base,
      servers,
      activeServerId: 'a',
      musicLibraryServerIds: ['missing', 'b', 'a'],
      musicFoldersByServer: {
        a: [{ id: '1', name: 'One' }, { id: 2, name: 'Bad' }],
        missing: [{ id: 'x', name: 'Gone' }],
      },
    } as unknown as AuthState);
    expect(patch.musicLibraryServerIds).toEqual(['a', 'b']);
    expect(patch.musicFoldersByServer).toEqual({ a: [{ id: '1', name: 'One' }] });
    expect(patch.musicFolders).toEqual([{ id: '1', name: 'One' }]);
  });

  it('falls back to the first server when persisted active and selected ids are stale', () => {
    const base = useAuthStore.getState();
    const servers = [
      { id: 'a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' },
      { id: 'b', name: 'B', url: 'https://b.test', username: 'u', password: 'p' },
    ];
    const patch = computeAuthStoreRehydration({
      ...base,
      servers,
      activeServerId: 'missing',
      musicLibraryServerIds: ['missing'],
    } as AuthState);
    expect(patch.activeServerId).toBe('a');
    expect(patch.musicLibraryServerIds).toEqual(['a']);
  });
});
