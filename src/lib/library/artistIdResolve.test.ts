import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  resolveArtistIds: vi.fn(),
}));

vi.mock('@/generated/bindings', () => ({
  commands: { libraryResolveArtistIds: hoisted.resolveArtistIds },
}));
// The command takes the library's SQL server id; the mapping itself is covered by
// `coverCache`'s own tests.
vi.mock('@/lib/api/coverCache', () => ({
  librarySqlServerId: (id: string) => id,
}));

import {
  __resetArtistIdResolveCacheForTests,
  clearArtistIdResolveCache,
  getArtistIdResolveRevision,
  peekArtistIdByName,
  resolveArtistIdsByName,
  subscribeArtistIdResolve,
} from '@/lib/library/artistIdResolve';

describe('resolveArtistIdsByName', () => {
  beforeEach(() => {
    __resetArtistIdResolveCacheForTests();
    hoisted.resolveArtistIds.mockReset();
  });

  it('asks for every unknown name in one batched call', async () => {
    hoisted.resolveArtistIds.mockResolvedValue({ status: 'ok', data: ['ar-a', null] });
    await resolveArtistIdsByName('srv', ['Alice', 'Bob']);

    expect(hoisted.resolveArtistIds).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveArtistIds).toHaveBeenCalledWith('srv', ['Alice', 'Bob']);
    expect(peekArtistIdByName('srv', 'Alice')).toBe('ar-a');
    // A miss is cached as null, not left unknown — otherwise it re-queries forever.
    expect(peekArtistIdByName('srv', 'Bob')).toBeNull();
  });

  it('never asks twice for the same name, whatever the casing', async () => {
    hoisted.resolveArtistIds.mockResolvedValue({ status: 'ok', data: ['ar-a'] });
    await resolveArtistIdsByName('srv', ['Alice']);
    await resolveArtistIdsByName('srv', ['  alice  ', 'ALICE']);

    expect(hoisted.resolveArtistIds).toHaveBeenCalledTimes(1);
    expect(peekArtistIdByName('srv', 'ALICE')).toBe('ar-a');
  });

  // The tracklist renders one row per song: without in-flight de-duplication every
  // row would fire its own request for the same guest before the first one returns.
  it('collapses concurrent requests for the same name into one call', async () => {
    let release: (value: unknown) => void = () => {};
    hoisted.resolveArtistIds.mockReturnValue(new Promise(resolve => { release = resolve; }));

    const first = resolveArtistIdsByName('srv', ['Alice']);
    const second = resolveArtistIdsByName('srv', ['Alice']);
    release({ status: 'ok', data: ['ar-a'] });
    await Promise.all([first, second]);

    expect(hoisted.resolveArtistIds).toHaveBeenCalledTimes(1);
  });

  it('keeps names unresolved when the call throws, so a retry is still possible', async () => {
    hoisted.resolveArtistIds.mockRejectedValue(new Error('ipc down'));
    await resolveArtistIdsByName('srv', ['Alice']);
    expect(peekArtistIdByName('srv', 'Alice')).toBeUndefined();

    hoisted.resolveArtistIds.mockResolvedValue({ status: 'ok', data: ['ar-a'] });
    await resolveArtistIdsByName('srv', ['Alice']);
    expect(peekArtistIdByName('srv', 'Alice')).toBe('ar-a');
  });

  // A backend `err` (busy index, sync in progress) says nothing about whether the
  // artist exists. Caching it as "no artist row" would leave every guest permanently
  // unlinkable after one transient failure.
  it('does not cache anything when the backend returns an error result', async () => {
    hoisted.resolveArtistIds.mockResolvedValue({ status: 'error', error: 'db busy' });
    await resolveArtistIdsByName('srv', ['Alice', 'Bob']);
    expect(peekArtistIdByName('srv', 'Alice')).toBeUndefined();
    expect(peekArtistIdByName('srv', 'Bob')).toBeUndefined();

    hoisted.resolveArtistIds.mockResolvedValue({ status: 'ok', data: ['ar-a', null] });
    await resolveArtistIdsByName('srv', ['Alice', 'Bob']);
    expect(peekArtistIdByName('srv', 'Alice')).toBe('ar-a');
  });

  // A tracklist mounts one row per song, each asking independently. Without batching
  // across callers that is one IPC per row, each taking the shared read connection.
  it('collapses independent callers in the same tick into a single call', async () => {
    hoisted.resolveArtistIds.mockResolvedValue({ status: 'ok', data: ['ar-a', 'ar-b', 'ar-c'] });
    await Promise.all([
      resolveArtistIdsByName('srv', ['Alice']),
      resolveArtistIdsByName('srv', ['Bob']),
      resolveArtistIdsByName('srv', ['Carol']),
    ]);

    expect(hoisted.resolveArtistIds).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveArtistIds).toHaveBeenCalledWith('srv', ['Alice', 'Bob', 'Carol']);
  });

  it('splits a batch larger than the backend cap into chunks of 32', async () => {
    const names = Array.from({ length: 33 }, (_, i) => `Artist ${i}`);
    hoisted.resolveArtistIds.mockImplementation((_server: string, chunk: string[]) =>
      Promise.resolve({ status: 'ok', data: chunk.map(() => null) }));

    await resolveArtistIdsByName('srv', names);

    expect(hoisted.resolveArtistIds).toHaveBeenCalledTimes(2);
    expect(hoisted.resolveArtistIds.mock.calls[0][1]).toHaveLength(32);
    expect(hoisted.resolveArtistIds.mock.calls[1][1]).toHaveLength(1);
  });

  // A virtualized row that mounts while the same guest is already being fetched must
  // not be told "done" before the value exists — it would render as plain text and
  // nothing would tell it when the original request finished.
  it('makes a late caller await the request that is already carrying its name', async () => {
    let release: (value: unknown) => void = () => {};
    hoisted.resolveArtistIds.mockReturnValue(new Promise(resolve => { release = resolve; }));

    const first = resolveArtistIdsByName('srv', ['Alice']);
    // Let the flush microtask run so the request is genuinely in flight.
    await Promise.resolve();
    await Promise.resolve();
    let lateSettled = false;
    const late = resolveArtistIdsByName('srv', ['Alice']).then(() => { lateSettled = true; });
    await Promise.resolve();
    expect(lateSettled).toBe(false);

    release({ status: 'ok', data: ['ar-a'] });
    await Promise.all([first, late]);
    expect(lateSettled).toBe(true);
    expect(peekArtistIdByName('srv', 'Alice')).toBe('ar-a');
    expect(hoisted.resolveArtistIds).toHaveBeenCalledTimes(1);
  });

  // A lookup issued before a sync describes the pre-sync index. If it lands after the
  // invalidation it reinstates exactly what the clear was there to remove.
  it('discards a response that was already in flight when the cache was cleared', async () => {
    let release: (value: unknown) => void = () => {};
    hoisted.resolveArtistIds.mockReturnValue(new Promise(resolve => { release = resolve; }));

    const pending = resolveArtistIdsByName('srv', ['Alice']);
    await Promise.resolve();
    clearArtistIdResolveCache();
    release({ status: 'ok', data: [null] });
    await pending;

    expect(peekArtistIdByName('srv', 'Alice')).toBeUndefined();
  });

  // The clear notifies while the request is still in flight, so a mounted row re-joins
  // that very batch — and its answer is then discarded. Without a signal afterwards the
  // row keeps its unresolved credits until it unmounts.
  it('signals a retry when a clear retires the answer a mounted consumer awaited', async () => {
    vi.useFakeTimers();
    try {
      const seen: number[] = [];
      subscribeArtistIdResolve(() => seen.push(getArtistIdResolveRevision()));
      let release: (value: unknown) => void = () => {};
      hoisted.resolveArtistIds.mockReturnValue(new Promise(resolve => { release = resolve; }));

      const pending = resolveArtistIdsByName('srv', ['Alice']);
      await Promise.resolve();
      clearArtistIdResolveCache();
      expect(seen).toHaveLength(1);

      release({ status: 'ok', data: ['ar-a'] });
      await pending;
      expect(peekArtistIdByName('srv', 'Alice')).toBeUndefined();
      expect(seen).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(seen).toHaveLength(2);

      hoisted.resolveArtistIds.mockResolvedValue({ status: 'ok', data: ['ar-a'] });
      await resolveArtistIdsByName('srv', ['Alice']);
      expect(peekArtistIdByName('srv', 'Alice')).toBe('ar-a');
      expect(seen).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('notifies subscribers when values land and when the cache is cleared', async () => {
    const seen: number[] = [];
    const unsubscribe = subscribeArtistIdResolve(() => seen.push(getArtistIdResolveRevision()));
    hoisted.resolveArtistIds.mockResolvedValue({ status: 'ok', data: ['ar-a'] });

    await resolveArtistIdsByName('srv', ['Alice']);
    expect(seen).toHaveLength(1);

    clearArtistIdResolveCache();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(seen[0]);
    unsubscribe();

    clearArtistIdResolveCache();
    expect(seen).toHaveLength(2);
  });

  // Failures stay uncached, but a mounted consumer has nothing that would make it ask
  // again. One backing-off retry signal is scheduled instead — the usual failure here
  // is backend contention, so it must not become a tight loop.
  it('signals a retry after a failure, backing off while it keeps failing', async () => {
    vi.useFakeTimers();
    try {
      const seen: number[] = [];
      subscribeArtistIdResolve(() => seen.push(getArtistIdResolveRevision()));
      hoisted.resolveArtistIds.mockResolvedValue({ status: 'error', error: 'db busy' });

      await resolveArtistIdsByName('srv', ['Alice']);
      expect(seen).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(seen).toHaveLength(1);

      await resolveArtistIdsByName('srv', ['Alice']);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(seen).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(seen).toHaveLength(2);

      hoisted.resolveArtistIds.mockResolvedValue({ status: 'ok', data: ['ar-a'] });
      await resolveArtistIdsByName('srv', ['Alice']);
      expect(peekArtistIdByName('srv', 'Alice')).toBe('ar-a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('scopes the cache per server and ignores blank input', async () => {
    hoisted.resolveArtistIds.mockResolvedValue({ status: 'ok', data: ['ar-a'] });
    await resolveArtistIdsByName('srv-a', ['Alice', '   ']);

    expect(hoisted.resolveArtistIds).toHaveBeenCalledWith('srv-a', ['Alice']);
    expect(peekArtistIdByName('srv-b', 'Alice')).toBeUndefined();

    await resolveArtistIdsByName('', ['Alice']);
    expect(hoisted.resolveArtistIds).toHaveBeenCalledTimes(1);
  });
});
