import { beforeEach, describe, expect, it } from 'vitest';
import { computeAuthStoreRehydration } from './authStoreRehydrate';
import { useAuthStore } from './authStore';
import type { AuthState } from './authStoreTypes';
import { resetAuthStore } from '@/test/helpers/storeReset';

describe('computeAuthStoreRehydration — scrobbling', () => {
  beforeEach(resetAuthStore);

  it.each([
    [undefined, 50],
    [null, 50],
    ['75', 50],
    [24, 25],
    [91, 90],
    [75, 75],
  ] as const)('sanitizes threshold %j to %s', (value, expected) => {
    const state = {
      ...useAuthStore.getState(),
      scrobbleThresholdPercent: value,
    } as unknown as AuthState;
    expect(computeAuthStoreRehydration(state).scrobbleThresholdPercent).toBe(expected);
  });

  it.each([undefined, null, 'true', 1, false] as const)(
    'keeps force scrobble off for non-true persisted value %j',
    value => {
      const state = {
        ...useAuthStore.getState(),
        forceScrobbleEnabled: value,
      } as unknown as AuthState;
      expect(computeAuthStoreRehydration(state).forceScrobbleEnabled).toBe(false);
    },
  );

  it('preserves an explicit force-scrobble opt-in', () => {
    const state = { ...useAuthStore.getState(), forceScrobbleEnabled: true };
    expect(computeAuthStoreRehydration(state).forceScrobbleEnabled).toBe(true);
  });
});

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

  it('clears tray-dependent settings when tray icon is off', () => {
    const base = useAuthStore.getState();
    const patch = computeAuthStoreRehydration({
      ...base,
      minimizeToTray: true,
      startMinimizedToTray: true,
      showTrayIcon: false,
    });
    expect(patch.minimizeToTray).toBe(false);
    expect(patch.startMinimizedToTray).toBe(false);
  });
});

describe('computeAuthStoreRehydration — discordCoverSource → coverSources (PR #1299)', () => {
  const SENTINEL_KEY = 'psysonic-discord-server-cover-revival-v1';
  const ALL_DISABLED = [
    { source: 'server' as const, enabled: false },
    { source: 'apple' as const, enabled: false },
    { source: 'lastfm' as const, enabled: false },
  ];
  const SERVER_ONLY = [
    { source: 'server' as const, enabled: true },
    { source: 'apple' as const, enabled: false },
    { source: 'lastfm' as const, enabled: false },
  ];
  const APPLE_ONLY = [
    { source: 'server' as const, enabled: false },
    { source: 'apple' as const, enabled: true },
    { source: 'lastfm' as const, enabled: false },
  ];

  beforeEach(() => {
    resetAuthStore();
    localStorage.clear();
  });

  it('coerces a stale pre-#1246 "server" value to an all-disabled chain exactly once', () => {
    const base = useAuthStore.getState();
    const patch = computeAuthStoreRehydration({ ...base, discordCoverSource: 'server' } as AuthState);
    expect(patch.coverSources).toEqual(ALL_DISABLED);
    expect(localStorage.getItem(SENTINEL_KEY)).toBe('1');
  });

  it('honors a post-revival "server" choice once the sentinel is already set', () => {
    localStorage.setItem(SENTINEL_KEY, '1');
    const base = useAuthStore.getState();
    const patch = computeAuthStoreRehydration({ ...base, discordCoverSource: 'server' } as AuthState);
    expect(patch.coverSources).toEqual(SERVER_ONLY);
  });

  it('sets the sentinel on first rehydrate even when the value is not "server"', () => {
    const base = useAuthStore.getState();
    computeAuthStoreRehydration({ ...base, discordCoverSource: 'none' } as AuthState);
    expect(localStorage.getItem(SENTINEL_KEY)).toBe('1');
  });

  it('maps "apple" and "none" onto the chain', () => {
    const base = useAuthStore.getState();
    const apple = computeAuthStoreRehydration({ ...base, discordCoverSource: 'apple' } as AuthState);
    expect(apple.coverSources).toEqual(APPLE_ONLY);
    const none = computeAuthStoreRehydration({ ...base, discordCoverSource: 'none' } as AuthState);
    expect(none.coverSources).toEqual(ALL_DISABLED);
  });

  it('is a no-op when no legacy discordCoverSource is present (never clobbers persisted chain)', () => {
    // Once the legacy field is gone the migration must not force the chain back
    // to all-disabled — doing so would overwrite the persisted coverSources on
    // every rehydrate and block the external album-cover chain (PR #1299 follow-up).
    const withSources = useAuthStore.getState();
    const patch = computeAuthStoreRehydration({
      ...withSources,
      coverSources: [
        { source: 'server', enabled: true },
        { source: 'apple', enabled: true },
        { source: 'lastfm', enabled: false },
      ],
    } as AuthState);
    expect('coverSources' in patch).toBe(false);
  });
});
