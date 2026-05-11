/**
 * Login / session / connection-state characterization for `authStore`.
 *
 * authStore has no single `login()` action — the UI composes:
 *   pingWithCredentials → addServer → setActiveServer → setLoggedIn
 * Tests target that composed sequence + the connection-state surface
 * (`isConnecting`, `connectionError`) and the Last.fm session helpers.
 *
 * Phase F2 / PR 3 of the pre-refactor testing plan.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from './authStore';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { makeServer } from '@/test/helpers/factories';

beforeEach(() => {
  resetAuthStore();
});

describe('login flow (composed)', () => {
  it('successful login: addServer → setActiveServer → setLoggedIn pins the active session', () => {
    const profile = makeServer({ name: 'Home' });
    const { addServer, setActiveServer, setLoggedIn } = useAuthStore.getState();

    const id = addServer({ name: profile.name, url: profile.url, username: profile.username, password: profile.password });
    setActiveServer(id);
    setLoggedIn(true);

    const s = useAuthStore.getState();
    expect(s.servers).toHaveLength(1);
    expect(s.servers[0]?.id).toBe(id);
    expect(s.servers[0]?.name).toBe('Home');
    expect(s.activeServerId).toBe(id);
    expect(s.isLoggedIn).toBe(true);
  });

  it('failed login (no addServer call) leaves prior valid state intact', () => {
    const existing = makeServer({ name: 'Existing' });
    const existingId = useAuthStore.getState().addServer({
      name: existing.name, url: existing.url, username: existing.username, password: existing.password,
    });
    useAuthStore.getState().setActiveServer(existingId);
    useAuthStore.getState().setLoggedIn(true);

    // Simulate ping failure — the UI sets connecting + error but does NOT
    // touch servers / activeServerId / isLoggedIn.
    useAuthStore.getState().setConnecting(true);
    useAuthStore.getState().setConnectionError('connection refused');
    useAuthStore.getState().setConnecting(false);

    const s = useAuthStore.getState();
    expect(s.servers).toHaveLength(1);
    expect(s.servers[0]?.id).toBe(existingId);
    expect(s.activeServerId).toBe(existingId);
    expect(s.isLoggedIn).toBe(true);
    expect(s.connectionError).toBe('connection refused');
  });

  it('addServer assigns a unique id even for duplicate-payload calls', () => {
    const make = () => useAuthStore.getState().addServer({
      name: 'Same', url: 'https://same.test', username: 'u', password: 'p',
    });
    const id1 = make();
    const id2 = make();
    expect(id1).not.toBe(id2);
    expect(useAuthStore.getState().servers).toHaveLength(2);
  });
});

describe('connection state', () => {
  it('setConnecting / setConnectionError toggle the loading + error fields independently', () => {
    const { setConnecting, setConnectionError } = useAuthStore.getState();

    setConnecting(true);
    expect(useAuthStore.getState().isConnecting).toBe(true);

    setConnectionError('boom');
    expect(useAuthStore.getState().connectionError).toBe('boom');

    setConnecting(false);
    setConnectionError(null);
    expect(useAuthStore.getState().isConnecting).toBe(false);
    expect(useAuthStore.getState().connectionError).toBeNull();
  });
});

describe('logout', () => {
  it('clears isLoggedIn + musicFolders but keeps the server entry', () => {
    const id = useAuthStore.getState().addServer({
      name: 'Home', url: 'https://x.test', username: 'u', password: 'p',
    });
    useAuthStore.getState().setActiveServer(id);
    useAuthStore.getState().setLoggedIn(true);
    useAuthStore.getState().setMusicFolders([{ id: 'mf-1', name: 'Music' }]);

    useAuthStore.getState().logout();

    const s = useAuthStore.getState();
    expect(s.isLoggedIn).toBe(false);
    expect(s.musicFolders).toEqual([]);
    expect(s.servers).toHaveLength(1);
    expect(s.activeServerId).toBe(id);
  });
});

describe('Last.fm session', () => {
  it('setLastfm stores api key + secret + session key + username together', () => {
    useAuthStore.getState().setLastfm('api', 'sec', 'session', 'frank');
    const s = useAuthStore.getState();
    expect(s.lastfmApiKey).toBe('api');
    expect(s.lastfmApiSecret).toBe('sec');
    expect(s.lastfmSessionKey).toBe('session');
    expect(s.lastfmUsername).toBe('frank');
  });

  it('connectLastfm sets only sessionKey + username (preserves api key / secret)', () => {
    useAuthStore.getState().setLastfm('app-key', 'app-sec', '', '');
    useAuthStore.getState().connectLastfm('user-session', 'frank');
    const s = useAuthStore.getState();
    expect(s.lastfmApiKey).toBe('app-key');
    expect(s.lastfmApiSecret).toBe('app-sec');
    expect(s.lastfmSessionKey).toBe('user-session');
    expect(s.lastfmUsername).toBe('frank');
  });

  it('disconnectLastfm clears session key + username + session error, keeps app credentials', () => {
    useAuthStore.getState().setLastfm('app-key', 'app-sec', 'session', 'frank');
    useAuthStore.getState().setLastfmSessionError(true);

    useAuthStore.getState().disconnectLastfm();

    const s = useAuthStore.getState();
    expect(s.lastfmSessionKey).toBe('');
    expect(s.lastfmUsername).toBe('');
    expect(s.lastfmSessionError).toBe(false);
    expect(s.lastfmApiKey).toBe('app-key');
    expect(s.lastfmApiSecret).toBe('app-sec');
  });
});
