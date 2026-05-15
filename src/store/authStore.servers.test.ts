/**
 * Server add / remove / update / switch characterization for `authStore`.
 *
 * Also includes the gapless / crossfade mutual-exclusion regression test
 * from §4.3 of the pre-refactor testing plan v2 — both flags live on
 * `authStore`, both UI surfaces (Settings + QueuePanel toolbar) clear the
 * other one before setting their own. A refactor that pushes mutex
 * enforcement into the setters would change the contract; the tests pin
 * the current caller-clears-first behaviour.
 *
 * Phase F2 / PR 3.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from './authStore';
import { usePlayerStore } from './playerStore';
import { resetAuthStore } from '@/test/helpers/storeReset';
import { resetPlayerStore } from '@/test/helpers/storeReset';
import { makeServer } from '@/test/helpers/factories';

function addThree(): { a: string; b: string; c: string } {
  const a = useAuthStore.getState().addServer({ name: 'A', url: 'https://a.test', username: 'u', password: 'p' });
  const b = useAuthStore.getState().addServer({ name: 'B', url: 'https://b.test', username: 'u', password: 'p' });
  const c = useAuthStore.getState().addServer({ name: 'C', url: 'https://c.test', username: 'u', password: 'p' });
  return { a, b, c };
}

beforeEach(() => {
  resetAuthStore();
  resetPlayerStore();
});

describe('addServer / updateServer', () => {
  it('appends a new server and returns its id', () => {
    const id = useAuthStore.getState().addServer({
      name: 'Home', url: 'https://x.test', username: 'u', password: 'p',
    });
    const s = useAuthStore.getState();
    expect(s.servers).toHaveLength(1);
    expect(s.servers[0]?.id).toBe(id);
    expect(s.servers[0]?.name).toBe('Home');
  });

  it('updateServer patches the matching server only', () => {
    const { a, b } = addThree();
    useAuthStore.getState().updateServer(a, { name: 'A-renamed', url: 'https://a-new.test' });
    const s = useAuthStore.getState();
    const sa = s.servers.find(srv => srv.id === a);
    const sb = s.servers.find(srv => srv.id === b);
    expect(sa?.name).toBe('A-renamed');
    expect(sa?.url).toBe('https://a-new.test');
    expect(sb?.name).toBe('B');
    expect(sb?.url).toBe('https://b.test');
  });

  it('updateServer is a no-op for an unknown id', () => {
    const { a } = addThree();
    const before = useAuthStore.getState().servers;
    useAuthStore.getState().updateServer('unknown-id', { name: 'X' });
    expect(useAuthStore.getState().servers).toEqual(before);
    expect(useAuthStore.getState().servers.find(s => s.id === a)?.name).toBe('A');
  });
});

describe('setActiveServer', () => {
  it('updates activeServerId and clears musicFolders (forces a refetch)', () => {
    const { a, b } = addThree();
    useAuthStore.getState().setActiveServer(a);
    useAuthStore.getState().setMusicFolders([{ id: 'mf-1', name: 'Music' }]);

    useAuthStore.getState().setActiveServer(b);
    const s = useAuthStore.getState();
    expect(s.activeServerId).toBe(b);
    expect(s.musicFolders).toEqual([]);
  });
});

describe('removeServer', () => {
  it('removes a non-active server without touching activeServerId or isLoggedIn', () => {
    const { a, b } = addThree();
    useAuthStore.getState().setActiveServer(a);
    useAuthStore.getState().setLoggedIn(true);

    useAuthStore.getState().removeServer(b);
    const s = useAuthStore.getState();
    expect(s.servers.map(srv => srv.id)).not.toContain(b);
    expect(s.activeServerId).toBe(a);
    expect(s.isLoggedIn).toBe(true);
  });

  it('removing the active server picks newServers[0] as the deterministic fallback', () => {
    const { a, b, c } = addThree();
    useAuthStore.getState().setActiveServer(a);

    useAuthStore.getState().removeServer(a);
    const s = useAuthStore.getState();
    expect(s.servers.map(srv => srv.id)).toEqual([b, c]);
    expect(s.activeServerId).toBe(b);
  });

  it('removing the only / active server clears activeServerId to null and forces logout', () => {
    const id = useAuthStore.getState().addServer({ name: 'Solo', url: 'https://s.test', username: 'u', password: 'p' });
    useAuthStore.getState().setActiveServer(id);
    useAuthStore.getState().setLoggedIn(true);

    useAuthStore.getState().removeServer(id);
    const s = useAuthStore.getState();
    expect(s.servers).toHaveLength(0);
    expect(s.activeServerId).toBeNull();
    expect(s.isLoggedIn).toBe(false);
  });

  it('cleans associated per-server bookkeeping maps (entityRatingSupport / instantMix / …)', () => {
    const { a, b } = addThree();
    useAuthStore.setState({
      entityRatingSupportByServer: { [a]: 'full', [b]: 'track_only' },
    });

    useAuthStore.getState().removeServer(a);
    expect(useAuthStore.getState().entityRatingSupportByServer).toEqual({ [b]: 'track_only' });
  });

  it('does not touch activeServerId when the removed id was inactive', () => {
    const { a, b } = addThree();
    useAuthStore.getState().setActiveServer(b);
    useAuthStore.getState().removeServer(a);
    expect(useAuthStore.getState().activeServerId).toBe(b);
  });

  it('clears queueServerId when the removed server owned the playback queue', () => {
    const { a, b } = addThree();
    useAuthStore.getState().setActiveServer(b);
    usePlayerStore.setState({
      queue: [{ id: 't1', title: 'T', artist: 'A', album: 'Al', albumId: 'al1', duration: 100 }],
      queueServerId: a,
      queueIndex: 0,
    });
    useAuthStore.getState().removeServer(a);
    expect(usePlayerStore.getState().queueServerId).toBeNull();
  });
});

describe('selectors — getBaseUrl / getActiveServer', () => {
  it('getActiveServer returns the entry matching activeServerId', () => {
    const { a, b } = addThree();
    useAuthStore.getState().setActiveServer(b);
    expect(useAuthStore.getState().getActiveServer()?.id).toBe(b);
  });

  it('getActiveServer returns undefined when no server is active', () => {
    expect(useAuthStore.getState().getActiveServer()).toBeUndefined();
  });

  it('getBaseUrl strips trailing slashes and adds http:// when missing', () => {
    useAuthStore.getState().addServer({ name: 'A', url: 'http://a.test/', username: 'u', password: 'p' });
    const a = useAuthStore.getState().servers[0]!.id;
    useAuthStore.getState().setActiveServer(a);
    expect(useAuthStore.getState().getBaseUrl()).toBe('http://a.test');

    const b = useAuthStore.getState().addServer({ name: 'B', url: 'b.local', username: 'u', password: 'p' });
    useAuthStore.getState().setActiveServer(b);
    expect(useAuthStore.getState().getBaseUrl()).toBe('http://b.local');
  });

  it('getBaseUrl returns empty string when no server is active', () => {
    expect(useAuthStore.getState().getBaseUrl()).toBe('');
  });
});

describe('audio modes — gapless / crossfade mutual exclusion (regression §4.3 of v2 plan)', () => {
  it('enabling gapless after the caller clears crossfade yields gapless-only', () => {
    useAuthStore.setState({ crossfadeEnabled: true, gaplessEnabled: false });
    // Caller pattern matches Settings.tsx:2565 — gapless toggle clears crossfade first.
    useAuthStore.getState().setCrossfadeEnabled(false);
    useAuthStore.getState().setGaplessEnabled(true);
    const s = useAuthStore.getState();
    expect(s.crossfadeEnabled).toBe(false);
    expect(s.gaplessEnabled).toBe(true);
  });

  it('enabling crossfade after the caller clears gapless yields crossfade-only', () => {
    useAuthStore.setState({ crossfadeEnabled: false, gaplessEnabled: true });
    useAuthStore.getState().setGaplessEnabled(false);
    useAuthStore.getState().setCrossfadeEnabled(true);
    const s = useAuthStore.getState();
    expect(s.gaplessEnabled).toBe(false);
    expect(s.crossfadeEnabled).toBe(true);
  });

  it('the setters themselves do NOT auto-clear the other flag — callers are responsible', () => {
    // Pinning the current contract: a refactor that moves mutex enforcement
    // into the setters would silently change behaviour for any caller that
    // doesn't already clear first.
    useAuthStore.setState({ crossfadeEnabled: true, gaplessEnabled: false });
    useAuthStore.getState().setGaplessEnabled(true);
    // Both end up true because the setter is a pure assignment.
    expect(useAuthStore.getState().crossfadeEnabled).toBe(true);
    expect(useAuthStore.getState().gaplessEnabled).toBe(true);
  });
});
