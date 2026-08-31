import { beforeEach, describe, expect, it } from 'vitest';
import { __resetWires, registerWire } from '../registry/wireRegistry';
import { MusicNetworkError } from '../core/errors';
import { scrobbleTargetRef, type PersistedAccount, type QueuedScrobble } from '../core/accounts';
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
  return {
    target: scrobbleTargetRef(account()),
    event: event(),
    attempts: 1,
    nextAttemptAt: NOW,
    ...over,
  };
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
const other = (u: string) => account({ id: u, username: u });
const deps = () => ({ setSessionError: () => {}, targets: () => [account()] });

beforeEach(() => {
  __resetWires();
  w = makeWire();
  registerWire(w.wire);
});

describe('withEnqueued', () => {
  it('takes custody of a failed play', () => {
    const q = withEnqueued([], account(), event(), NOW);
    expect(q).toHaveLength(1);
    expect(q[0].attempts).toBe(1);
    expect(q[0].nextAttemptAt).toBe(NOW + backoffFor(1));
  });

  it('does not owe the same play twice to the same destination', () => {
    const once = withEnqueued([], account(), event(), NOW);
    expect(withEnqueued(once, account(), event(), NOW)).toHaveLength(1);
  });

  it('owes the same play separately per destination', () => {
    const q = withEnqueued(withEnqueued([], account(), event(), NOW), other('a2'), event(), NOW);
    expect(q.map(e => e.target.username)).toEqual(['', 'a2']);
  });

  it('drops plays too old for any destination to accept', () => {
    const ancient = entry({ event: event({ timestamp: NOW - SCROBBLE_MAX_AGE_MS - 1 }) });
    const q = withEnqueued([ancient], other('a2'), event(), NOW);
    expect(q).toHaveLength(1);
    expect(q[0].target.username).toBe('a2');
  });

  it('caps the queue by dropping the oldest play first', () => {
    const full = Array.from({ length: SCROBBLE_QUEUE_MAX }, (_, i) =>
      entry({ target: scrobbleTargetRef(other(`old-${i}`)), event: event({ timestamp: NOW - (i + 1) * 1000 }) }),
    );
    const q = withEnqueued(full, other('fresh'), event(), NOW);
    expect(q).toHaveLength(SCROBBLE_QUEUE_MAX);
    expect(q.some(e => e.target.username === 'fresh')).toBe(true);
    // The entry furthest in the past is the one that made room.
    expect(q.some(e => e.target.username === `old-${SCROBBLE_QUEUE_MAX - 1}`)).toBe(false);
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
    expect(await flushQueue([entry()], deps(), () => NOW)).toEqual([]);
    expect(w.calls).toHaveLength(1);
  });

  it('keeps the original play timestamp on retry', async () => {
    const played = NOW - 3_600_000;
    await flushQueue([entry({ event: event({ timestamp: played }) })], deps(), () => NOW);
    expect(w.calls[0].timestamp).toBe(played);
  });

  it('backs off further after another transport failure', async () => {
    w.failWith(new MusicNetworkError('NETWORK', 'offline'));
    const [kept] = await flushQueue([entry({ attempts: 1 })], deps(), () => NOW);
    expect(kept.attempts).toBe(2);
    expect(kept.nextAttemptAt).toBe(NOW + backoffFor(2));
  });

  it('holds the play through a rejected session', async () => {
    // The session is repairable, and entries key on the destination rather than
    // the account id, so they survive the disconnect-and-reconnect that repairs
    // it. The flag is raised for the reconnect prompt; the play waits.
    w.failWith(new MusicNetworkError('AUTH_SESSION_INVALID', 'bad key'));
    const kept = await flushQueue([entry()], deps(), () => NOW);
    expect(kept).toHaveLength(1);
  });

  it('gives up on a misconfigured destination', async () => {
    w.failWith(new MusicNetworkError('CUSTOM_URL_INVALID', 'nope'));
    expect(await flushQueue([entry()], deps(), () => NOW)).toEqual([]);
  });

  it('leaves an entry alone until its backoff has passed', async () => {
    const pending = entry({ nextAttemptAt: NOW + 60_000 });
    expect(await flushQueue([pending], deps(), () => NOW)).toEqual([pending]);
    expect(w.calls).toHaveLength(0);
  });

  it('holds a play whose destination is absent right now', async () => {
    // Disconnected, switched off, or mid-reconnect. Discarding here would defeat
    // the point of a persistent queue: the destination usually comes back.
    const absent = entry({ target: scrobbleTargetRef(other('gone')) });
    expect(await flushQueue([absent], deps(), () => NOW)).toEqual([absent]);
    expect(w.calls).toHaveLength(0);
  });

  it('discards a play that aged out while queued', async () => {
    const stale = entry({ event: event({ timestamp: NOW - SCROBBLE_MAX_AGE_MS - 1 }) });
    expect(await flushQueue([stale], deps(), () => NOW)).toEqual([]);
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
    await flushQueue(backlog, deps(), () => NOW);
    expect(maxInFlight).toBe(1);
  });

  it('keeps retrying a long-failing entry instead of deleting it', async () => {
    // There is deliberately no attempt ceiling: NETWORK is also what an offline
    // machine produces, so counting failures would delete the head of the queue
    // after a day offline while the entry advertises a fortnight. Expiry is the
    // only thing that ends an entry's life.
    w.failWith(new MusicNetworkError('NETWORK', 'nope'));
    const veteran = entry({ attempts: 500 });
    const [kept] = await flushQueue([veteran], deps(), () => NOW);
    expect(kept.attempts).toBe(501);
  });

  it('reports progress after every entry so a crash cannot replay deliveries', async () => {
    // Persisting only at the end would leave already-sent plays queued if the app
    // quits mid-flush, and they would go out again on the next launch.
    const seen: number[] = [];
    const backlog = [
      entry({ event: event({ timestamp: NOW - 3000 }) }),
      entry({ event: event({ timestamp: NOW - 2000 }) }),
      entry({ event: event({ timestamp: NOW - 1000 }) }),
    ];
    await flushQueue(backlog, deps(), () => NOW, remaining => seen.push(remaining.length));
    expect(seen).toEqual([2, 1, 0]);
  });

  it('dates a retry from the attempt, not from when the flush started', async () => {
    // A backlog can span many minutes; a timestamp taken before the loop would
    // make every retry due again on the next tick.
    w.failWith(new MusicNetworkError('NETWORK', 'nope'));
    let clock = NOW;
    const [kept] = await flushQueue([entry()], deps(), () => (clock += 60_000));
    expect(kept.nextAttemptAt).toBeGreaterThan(NOW + backoffFor(2));
  });

  it('returns the same queue when the play is already owed', () => {
    // Identity, not just equality — the caller skips the persist write on a no-op.
    const q = withEnqueued([], account(), event(), NOW);
    expect(withEnqueued(q, account(), event(), NOW)).toBe(q);
  });
});


describe('a refusing destination is asked once per pass', () => {
  it('does not burn an attempt on every entry when the provider rate-limits', async () => {
    // The wires collapse a rate-limit rejection into NETWORK. Trying all 5 would
    // increment attempts on all 5, and a few passes later they hit the give-up
    // ceiling and are discarded — the loss the queue exists to prevent.
    w.failWith(new MusicNetworkError('NETWORK', 'rate limited'));
    const backlog = [1, 2, 3, 4, 5].map(i =>
      entry({ event: event({ timestamp: NOW - i * 1000 }), attempts: 1 }),
    );

    const kept = await flushQueue(backlog, deps(), () => NOW);

    expect(w.calls).toHaveLength(0);
    expect(kept).toHaveLength(5);
    // Only the entry that actually reached the provider counts an attempt.
    expect(kept.filter(e => e.attempts === 2)).toHaveLength(1);
    expect(kept.filter(e => e.attempts === 1)).toHaveLength(4);
  });

  it('sees a session flag raised during the same pass', async () => {
    // `targets` is a function so the flag written by the first failure is visible
    // to the entries after it; a snapshot would report the stale value.
    const accounts = [account()];
    const deltaDeps = {
      setSessionError: (_id: string, invalid: boolean) => {
        accounts[0] = { ...accounts[0], sessionError: invalid };
      },
      targets: () => accounts,
    };
    w.failWith(new MusicNetworkError('AUTH_SESSION_INVALID', 'stale'));
    const backlog = [1, 2, 3].map(i => entry({ event: event({ timestamp: NOW - i * 1000 }) }));

    const kept = await flushQueue(backlog, deltaDeps, () => NOW);

    expect(kept).toHaveLength(3);
    expect(accounts[0].sessionError).toBe(true);
  });
});

describe('a repairable auth failure keeps the play', () => {
  it('holds a Maloja key rejection instead of discarding it', async () => {
    // Any 401/403 from a Maloja instance arrives as MALOJA_BAD_KEY — a rotated
    // key, a restart, or an auth gateway in front of it. Treating it as final
    // discarded every play silently while the card still read "Connected".
    w.failWith(new MusicNetworkError('MALOJA_BAD_KEY', 'denied'));
    expect(await flushQueue([entry()], deps(), () => NOW)).toHaveLength(1);
  });

  it('raises the reconnect flag for it', async () => {
    const flagged: string[] = [];
    w.failWith(new MusicNetworkError('MALOJA_BAD_KEY', 'denied'));
    await flushQueue([entry()], {
      setSessionError: (id, invalid) => { if (invalid) flagged.push(id); },
      targets: () => [account()],
    }, () => NOW);
    expect(flagged).toEqual(['a1']);
  });

  it('prefers a healthy account over a flagged one for the same destination', async () => {
    // Reconnecting appends a second account for the same host; the stale flagged
    // one stays first. Picking it would park the backlog until it expired.
    const stale = account({ id: 'stale', sessionError: true });
    const healthy = account({ id: 'healthy' });
    const kept = await flushQueue([entry()], {
      setSessionError: () => {},
      targets: () => [stale, healthy],
    }, () => NOW);
    expect(w.calls).toHaveLength(1);
    expect(kept).toEqual([]);
  });
});
