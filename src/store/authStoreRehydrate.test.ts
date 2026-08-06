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

describe('computeAuthStoreRehydration — debugLoggingDepth', () => {
  beforeEach(resetAuthStore);

  it.each([1, 3] as const)('preserves valid depth %s', (depth) => {
    const patch = computeAuthStoreRehydration({
      ...useAuthStore.getState(),
      debugLoggingDepth: depth,
    });
    expect(patch.debugLoggingDepth).toBe(depth);
  });

  it.each([0, 2, 4, '3', null, undefined] as const)(
    'maps invalid or missing depth %j to level 1',
    (depth) => {
      const state = { ...useAuthStore.getState(), debugLoggingDepth: depth } as unknown as AuthState;
      const patch = computeAuthStoreRehydration(state);
      expect(patch.debugLoggingDepth).toBe(1);
    },
  );
});

describe('computeAuthStoreRehydration — Library browse scope', () => {
  beforeEach(() => {
    resetAuthStore();
    localStorage.clear();
  });

  it('migrates legacy state to the active server and sanitizes folder maps', () => {
    const base = useAuthStore.getState();
    const servers = [
      { id: 'a', name: 'A', url: 'https://a.test', username: 'u', password: 'p' },
      { id: 'b', name: 'B', url: 'https://b.test', username: 'u', password: 'p' },
    ];
    const patch = computeAuthStoreRehydration({
      ...base,
      servers,
      activeServerId: 'b',
      libraryBrowseServerIds: ['missing'] as never,
      musicFoldersByServer: {
        a: [{ id: 'a1', name: 'A1' }],
        missing: [{ id: 'x', name: 'X' }],
      },
    });

    expect(patch.libraryBrowseServerIds).toEqual(['b']);
    expect(patch.musicFoldersByServer).toEqual({ a: [{ id: 'a1', name: 'A1' }] });
  });

  it('attaches a legacy one-server profile when the persisted scope field is absent', () => {
    const base = useAuthStore.getState();
    const { libraryBrowseServerIds: _missing, ...legacy } = base;
    const server = {
      id: 'legacy',
      name: 'Legacy',
      url: 'https://legacy.test',
      username: 'u',
      password: 'p',
    };

    const patch = computeAuthStoreRehydration({
      ...legacy,
      servers: [server],
      activeServerId: server.id,
    } as AuthState);

    expect(patch.libraryBrowseServerIds).toEqual([server.id]);
  });
});

describe('computeAuthStoreRehydration — lyrics', () => {
  beforeEach(() => {
    resetAuthStore();
    localStorage.clear();
  });

  // The removed YouLyPlus option (issue #1386) was the only lyrics source for
  // some users. Retiring it must not leave them without lyrics.
  it('enables LRCLIB for a user who only had YouLyPlus on', () => {
    const base = useAuthStore.getState();
    const patch = computeAuthStoreRehydration({
      ...base,
      youLyPlusEnabled: true,
      lyricsSources: [
        { id: 'server', enabled: false },
        { id: 'lrclib', enabled: false },
        { id: 'netease', enabled: false },
      ],
    } as unknown as AuthState);
    expect(patch.lyricsSources).toEqual([
      { id: 'server', enabled: false },
      { id: 'lrclib', enabled: true },
      { id: 'netease', enabled: false },
    ]);
  });

  it('does the same for the even older lyricsMode "lyricsplus" flag', () => {
    const base = useAuthStore.getState();
    const patch = computeAuthStoreRehydration({
      ...base,
      lyricsMode: 'lyricsplus',
      lyricsSources: [
        { id: 'server', enabled: false },
        { id: 'lrclib', enabled: false },
        { id: 'netease', enabled: false },
      ],
    } as unknown as AuthState);
    expect(patch.lyricsSources?.find(s => s.id === 'lrclib')?.enabled).toBe(true);
  });

  it('leaves a deliberate source selection untouched', () => {
    const base = useAuthStore.getState();
    const patch = computeAuthStoreRehydration({
      ...base,
      youLyPlusEnabled: true,
      lyricsSources: [
        { id: 'server', enabled: true },
        { id: 'lrclib', enabled: false },
        { id: 'netease', enabled: false },
      ],
    } as unknown as AuthState);
    // Nothing to rescue — the user still has a working source, so the patch must
    // not carry `lyricsSources` at all (absent = left as the user set it).
    expect(patch.lyricsSources).toBeUndefined();
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
