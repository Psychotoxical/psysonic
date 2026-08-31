import { beforeEach, describe, expect, it } from 'vitest';
import { MusicNetworkRuntime } from './MusicNetworkRuntime';
import type { MusicNetworkStore, RuntimeHost } from './store';
import { __resetWires, registerWire } from '../registry/wireRegistry';
import { MusicNetworkError } from '../core/errors';
import type { MusicNetworkState, PersistedAccount, QueuedScrobble } from '../core/accounts';
import type { EnrichmentWire } from '../contracts/EnrichmentWire';
import type { ScrobbleWire } from '../contracts/ScrobbleWire';
import type { ScrobbleEvent } from '../core/types';

// ── mock wires ───────────────────────────────────────────────────────────────

function makeAudioscrobblerMock() {
  const calls = { scrobble: 0, nowPlaying: 0, loved: 0 };
  let failSession = false;
  const wire: EnrichmentWire = {
    wireId: 'audioscrobbler_v2',
    supportsEnrichment: true,
    async connect() { return { sessionKey: 'sk', username: 'u' }; },
    disconnect() {},
    async scrobble() {
      if (failSession) throw new MusicNetworkError('AUTH_SESSION_INVALID', 'bad');
      calls.scrobble++;
    },
    async updateNowPlaying() { calls.nowPlaying++; },
    async probe() { return {}; },
    async getTrackLoved() { calls.loved++; return true; },
    async loveTrack() {},
    async getAllLovedTracks() { return [{ title: 'T', artist: 'A' }]; },
    async getSimilarArtists() { return ['B']; },
    async getTrackStats() { return null; },
    async getArtistStats() { return null; },
    async getUserProfile() { return null; },
    async getTopItems() { return []; },
    async getRecentTracks() { return []; },
    buildProfileUrl() { return 'https://www.last.fm/user/u'; },
    buildArtistUrl() { return 'https://www.last.fm/music/A'; },
    buildTrackUrl() { return 'https://www.last.fm/music/A/_/T'; },
  };
  return { wire, calls, setFailSession: (v: boolean) => { failSession = v; } };
}

function makeListenBrainzMock() {
  const calls = { scrobble: 0, nowPlaying: 0 };
  const wire: ScrobbleWire = {
    wireId: 'listenbrainz',
    supportsEnrichment: false,
    async connect() { return { sessionKey: 'tok', username: '' }; },
    disconnect() {},
    async scrobble() { calls.scrobble++; },
    async updateNowPlaying() { calls.nowPlaying++; },
    async probe() { return {}; },
  };
  return { wire, calls };
}

// ── in-memory store ──────────────────────────────────────────────────────────

// Callers predate the queue field; default it here so their literals stay terse.
function memStore(
  initial: Omit<MusicNetworkState, 'scrobbleQueue'> & { scrobbleQueue?: QueuedScrobble[] },
): MusicNetworkStore {
  let state: MusicNetworkState = { scrobbleQueue: [], ...initial };
  return {
    getState: () => state,
    setAccounts: a => { state = { ...state, accounts: a }; },
    setEnrichmentPrimaryId: id => { state = { ...state, enrichmentPrimaryId: id }; },
    setScrobbleQueue: q => { state = { ...state, scrobbleQueue: q }; },
  };
}

const host: RuntimeHost = { openExternal: async () => {}, newId: () => 'new-id' };

function lastfmAccount(over: Partial<PersistedAccount> = {}): PersistedAccount {
  return {
    id: 'a1', presetId: 'lastfm', wireId: 'audioscrobbler_v2', label: 'Last.fm',
    baseUrl: '', scrobbleEnabled: true, sessionKey: 'sk1', username: 'u1',
    apiKey: 'k', apiSecret: 's', sessionError: false,
    capabilities: { scrobble: { status: 'yes' }, nowPlaying: { status: 'yes' } },
    ...over,
  };
}

function lbAccount(over: Partial<PersistedAccount> = {}): PersistedAccount {
  return {
    id: 'a2', presetId: 'listenbrainz', wireId: 'listenbrainz', label: 'ListenBrainz',
    baseUrl: 'https://api.listenbrainz.org', scrobbleEnabled: true, sessionKey: 'tok', username: '',
    apiKey: '', apiSecret: '', sessionError: false,
    capabilities: { scrobble: { status: 'yes' }, nowPlaying: { status: 'yes' } },
    ...over,
  };
}

const EVENT: ScrobbleEvent = { title: 'T', artist: 'A', album: 'Al', duration: 200, timestamp: 1_700_000_000_000 };

let as: ReturnType<typeof makeAudioscrobblerMock>;
let lb: ReturnType<typeof makeListenBrainzMock>;

beforeEach(() => {
  __resetWires();
  as = makeAudioscrobblerMock();
  lb = makeListenBrainzMock();
  registerWire(as.wire);
  registerWire(lb.wire);
});

describe('scrobble fan-out', () => {
  it('dispatches to every enabled destination when master is on', async () => {
    const rt = new MusicNetworkRuntime(
      memStore({ scrobblingMasterEnabled: true, enrichmentPrimaryId: null, accounts: [lastfmAccount(), lbAccount()] }),
      host,
    );
    await rt.dispatchScrobble(EVENT);
    expect(as.calls.scrobble).toBe(1);
    expect(lb.calls.scrobble).toBe(1);
  });

  it('dispatches nothing when the master toggle is off', async () => {
    const rt = new MusicNetworkRuntime(
      memStore({ scrobblingMasterEnabled: false, enrichmentPrimaryId: null, accounts: [lastfmAccount(), lbAccount()] }),
      host,
    );
    await rt.dispatchScrobble(EVENT);
    expect(as.calls.scrobble).toBe(0);
    expect(lb.calls.scrobble).toBe(0);
  });

  it('skips accounts with scrobbling disabled', async () => {
    const rt = new MusicNetworkRuntime(
      memStore({ scrobblingMasterEnabled: true, enrichmentPrimaryId: null, accounts: [lastfmAccount({ scrobbleEnabled: false }), lbAccount()] }),
      host,
    );
    await rt.dispatchScrobble(EVENT);
    expect(as.calls.scrobble).toBe(0);
    expect(lb.calls.scrobble).toBe(1);
  });

  it('only sends now-playing to capable destinations', async () => {
    const rt = new MusicNetworkRuntime(
      memStore({
        scrobblingMasterEnabled: true,
        enrichmentPrimaryId: null,
        accounts: [lastfmAccount(), lbAccount({ capabilities: { scrobble: { status: 'yes' }, nowPlaying: { status: 'no' } } })],
      }),
      host,
    );
    await rt.dispatchNowPlaying(EVENT);
    expect(as.calls.nowPlaying).toBe(1);
    expect(lb.calls.nowPlaying).toBe(0);
  });

  it('flips session-error on AUTH_SESSION_INVALID and clears it on success', async () => {
    const store = memStore({ scrobblingMasterEnabled: true, enrichmentPrimaryId: null, accounts: [lastfmAccount()] });
    const rt = new MusicNetworkRuntime(store, host);

    as.setFailSession(true);
    await rt.dispatchScrobble(EVENT);
    expect(store.getState().accounts[0].sessionError).toBe(true);

    as.setFailSession(false);
    await rt.dispatchScrobble(EVENT);
    expect(store.getState().accounts[0].sessionError).toBe(false);
  });
});

describe('enrichment primary', () => {
  it('rejects a non-eligible account (ListenBrainz) as primary', () => {
    const rt = new MusicNetworkRuntime(
      memStore({ scrobblingMasterEnabled: true, enrichmentPrimaryId: null, accounts: [lastfmAccount(), lbAccount()] }),
      host,
    );
    expect(() => rt.setEnrichmentPrimaryId('a2')).toThrow(MusicNetworkError);
  });

  it('routes love/similar to the enrichment wire when the primary is eligible', async () => {
    const rt = new MusicNetworkRuntime(
      memStore({ scrobblingMasterEnabled: true, enrichmentPrimaryId: 'a1', accounts: [lastfmAccount(), lbAccount()] }),
      host,
    );
    expect(await rt.isTrackLoved({ title: 'T', artist: 'A' })).toBe(true);
    expect(as.calls.loved).toBe(1);
    expect(await rt.getSimilarArtists('A')).toEqual(['B']);
  });

  it('returns inert defaults when no primary is set', async () => {
    const rt = new MusicNetworkRuntime(
      memStore({ scrobblingMasterEnabled: true, enrichmentPrimaryId: null, accounts: [lastfmAccount()] }),
      host,
    );
    expect(await rt.isTrackLoved({ title: 'T', artist: 'A' })).toBe(false);
    expect(await rt.getSimilarArtists('A')).toEqual([]);
    expect(rt.profileUrl()).toBeNull();
  });
});

describe('owed scrobbles', () => {
  // The shared EVENT is pinned to 2023 and would age out of the queue on sight,
  // so these tests use a play from just now.
  const fresh = (): ScrobbleEvent => ({ ...EVENT, timestamp: Date.now() });

  it('takes custody of a play a destination could not receive', async () => {
    const store = memStore({
      scrobblingMasterEnabled: true,
      enrichmentPrimaryId: null,
      accounts: [lbAccount()],
    });
    lb.wire.scrobble = async () => { throw new MusicNetworkError('NETWORK', 'offline'); };
    const rt = new MusicNetworkRuntime(store, host);

    await rt.dispatchScrobble(fresh());

    expect(rt.owedScrobbleCount()).toBe(1);
    expect(store.getState().scrobbleQueue[0]).toMatchObject({
      accountId: lbAccount().id,
      attempts: 1,
    });
  });

  it('does not owe a play the destination refused on authentication', async () => {
    // A rejected session is not fixed by waiting; retrying it forever would fill
    // the queue with mail that can never be delivered.
    const store = memStore({
      scrobblingMasterEnabled: true,
      enrichmentPrimaryId: null,
      accounts: [lbAccount()],
    });
    lb.wire.scrobble = async () => { throw new MusicNetworkError('AUTH_SESSION_INVALID', 'bad'); };
    const rt = new MusicNetworkRuntime(store, host);

    await rt.dispatchScrobble(fresh());

    expect(rt.owedScrobbleCount()).toBe(0);
  });

  it('delivers an owed play once the destination answers again', async () => {
    const store = memStore({
      scrobblingMasterEnabled: true,
      enrichmentPrimaryId: null,
      accounts: [lbAccount()],
      scrobbleQueue: [
        { accountId: lbAccount().id, event: fresh(), attempts: 1, nextAttemptAt: 0 },
      ],
    });
    const rt = new MusicNetworkRuntime(store, host);

    await rt.flushOwedScrobbles();

    expect(lb.calls.scrobble).toBe(1);
    expect(rt.owedScrobbleCount()).toBe(0);
  });

  it('leaves a now-playing failure unqueued', async () => {
    // Stale presence is worse than none, so it is deliberately not retried.
    const store = memStore({
      scrobblingMasterEnabled: true,
      enrichmentPrimaryId: null,
      accounts: [lbAccount()],
    });
    lb.wire.updateNowPlaying = async () => { throw new MusicNetworkError('NETWORK', 'offline'); };
    const rt = new MusicNetworkRuntime(store, host);

    await rt.dispatchNowPlaying(fresh());

    expect(rt.owedScrobbleCount()).toBe(0);
  });
});
