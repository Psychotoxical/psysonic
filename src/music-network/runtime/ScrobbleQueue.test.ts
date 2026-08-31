import { beforeEach, describe, expect, it } from 'vitest';
import { __resetWires, registerWire } from '../registry/wireRegistry';
import { MusicNetworkError } from '../core/errors';
import type { PersistedAccount, QueuedScrobble } from '../core/accounts';
import type { ScrobbleWire } from '../contracts/ScrobbleWire';
import type { ScrobbleEvent } from '../core/types';
import {
  backoffFor,
  flushQueue,
  withEnqueued,
  SCROBBLE_QUEUE_MAX,
  SCROBBLE_MAX_AGE_MS,
} from './ScrobbleQueue';

const NOW = 1_700_000_000_000;

function event(over: Partial<ScrobbleEvent> = {}): ScrobbleEvent {
  return { title: 'T', artist: 'A', album: 'Al', duration: 200, timestamp: NOW, ...over };
}

function account(over: Partial<PersistedAccount> = {}): PersistedAccount {
  return {
    id: 'a1', presetId: 'listenbrainz', wireId: 'listenbrainz', label: 'LB',
    baseUrl: 'https://api.listenbrainz.org', scrobbleEnabled: true, sessionKey: 'tok',
    username: '', apiKey: '', apiSecret: '', sessionError: false,
    capabilities: { scrobble: { status: 'yes' }, nowPlaying: { status: 'yes' } },
    ...over,
  };
}

function entry(over: Partial<QueuedScrobble> = {}): QueuedScrobble {
  return { accountId: 'a1', event: event(), attempts: 1, nextAttemptAt: NOW, ...over };
}

/** Wire whose scrobble outcome the test drives. */
function makeWire() {
  const calls: ScrobbleEvent[] = [];
  let fail: MusicNetworkError | Error | null = null;
  const wire: ScrobbleWire = {
    wireId: 'listenbrainz',
    supportsEnrichment: false,
    async connect() { return { sessionKey: 'tok', username: '' }; },
    disconnect() {},
    async scrobble(_ctx, e) { if (fail) throw fail; calls.push(e); },
    async updateNowPlaying() {},
    async probe() { return {}; },
  };
  return { wire, calls, failWith: (e: MusicNetworkError | Error | null) => { fail = e; } };
}

let w: ReturnType<typeof makeWire>;
const deps = () => ({ setSessionError: () => {}, targets: [account()] });

beforeEach(() => {
  __resetWires();
  w = makeWire();
  registerWire(w.wire);
});

describe('withEnqueued', () => {
  it('takes custody of a failed play', () => {
    const q = withEnqueued([], 'a1', event(), NOW);
    expect(q).toHaveLength(1);
    expect(q[0].attempts).toBe(1);
    expect(q[0].nextAttemptAt).toBe(NOW + backoffFor(1));
  });

  it('does not owe the same play twice to the same destination', () => {
    const once = withEnqueued([], 'a1', event(), NOW);
    expect(withEnqueued(once, 'a1', event(), NOW)).toHaveLength(1);
  });

  it('owes the same play separately per destination', () => {
    const q = withEnqueued(withEnqueued([], 'a1', event(), NOW), 'a2', event(), NOW);
    expect(q.map(e => e.accountId)).toEqual(['a1', 'a2']);
  });

  it('drops plays too old for any destination to accept', () => {
    const ancient = entry({ event: event({ timestamp: NOW - SCROBBLE_MAX_AGE_MS - 1 }) });
    const q = withEnqueued([ancient], 'a2', event(), NOW);
    expect(q).toHaveLength(1);
    expect(q[0].accountId).toBe('a2');
  });

  it('caps the queue by dropping the oldest play first', () => {
    const full = Array.from({ length: SCROBBLE_QUEUE_MAX }, (_, i) =>
      entry({ accountId: `old-${i}`, event: event({ timestamp: NOW - (i + 1) * 1000 }) }),
    );
    const q = withEnqueued(full, 'fresh', event(), NOW);
    expect(q).toHaveLength(SCROBBLE_QUEUE_MAX);
    expect(q.some(e => e.accountId === 'fresh')).toBe(true);
    // The entry furthest in the past is the one that made room.
    expect(q.some(e => e.accountId === `old-${SCROBBLE_QUEUE_MAX - 1}`)).toBe(false);
  });
});

describe('backoffFor', () => {
  it('doubles and then holds at the ceiling', () => {
    expect(backoffFor(1)).toBe(60_000);
    expect(backoffFor(2)).toBe(120_000);
    expect(backoffFor(3)).toBe(240_000);
    expect(backoffFor(99)).toBe(60 * 60_000);
  });
});

describe('flushQueue', () => {
  it('clears an entry that is delivered', async () => {
    expect(await flushQueue([entry()], deps(), NOW)).toEqual([]);
    expect(w.calls).toHaveLength(1);
  });

  it('keeps the original play timestamp on retry', async () => {
    const played = NOW - 3_600_000;
    await flushQueue([entry({ event: event({ timestamp: played }) })], deps(), NOW);
    expect(w.calls[0].timestamp).toBe(played);
  });

  it('backs off further after another transport failure', async () => {
    w.failWith(new MusicNetworkError('NETWORK', 'offline'));
    const [kept] = await flushQueue([entry({ attempts: 1 })], deps(), NOW);
    expect(kept.attempts).toBe(2);
    expect(kept.nextAttemptAt).toBe(NOW + backoffFor(2));
  });

  it('gives up on a rejected session instead of retrying forever', async () => {
    w.failWith(new MusicNetworkError('AUTH_SESSION_INVALID', 'bad key'));
    expect(await flushQueue([entry()], deps(), NOW)).toEqual([]);
  });

  it('gives up on a misconfigured destination', async () => {
    w.failWith(new MusicNetworkError('CUSTOM_URL_INVALID', 'nope'));
    expect(await flushQueue([entry()], deps(), NOW)).toEqual([]);
  });

  it('leaves an entry alone until its backoff has passed', async () => {
    const pending = entry({ nextAttemptAt: NOW + 60_000 });
    expect(await flushQueue([pending], deps(), NOW)).toEqual([pending]);
    expect(w.calls).toHaveLength(0);
  });

  it('discards plays owed to a destination the user removed', async () => {
    const orphan = entry({ accountId: 'gone' });
    expect(await flushQueue([orphan], deps(), NOW)).toEqual([]);
    expect(w.calls).toHaveLength(0);
  });

  it('discards a play that aged out while queued', async () => {
    const stale = entry({ event: event({ timestamp: NOW - SCROBBLE_MAX_AGE_MS - 1 }) });
    expect(await flushQueue([stale], deps(), NOW)).toEqual([]);
    expect(w.calls).toHaveLength(0);
  });

  it('sends a backlog one at a time rather than as a burst', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const slow = makeWire();
    slow.wire.scrobble = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    };
    __resetWires();
    registerWire(slow.wire);
    const backlog = Array.from({ length: 5 }, (_, i) =>
      entry({ event: event({ timestamp: NOW - i * 1000 }) }),
    );
    await flushQueue(backlog, deps(), NOW);
    expect(maxInFlight).toBe(1);
  });
});
