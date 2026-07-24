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
  peekArtistIdByName,
  resolveArtistIdsByName,
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

  it('scopes the cache per server and ignores blank input', async () => {
    hoisted.resolveArtistIds.mockResolvedValue({ status: 'ok', data: ['ar-a'] });
    await resolveArtistIdsByName('srv-a', ['Alice', '   ']);

    expect(hoisted.resolveArtistIds).toHaveBeenCalledWith('srv-a', ['Alice']);
    expect(peekArtistIdByName('srv-b', 'Alice')).toBeUndefined();

    await resolveArtistIdsByName('', ['Alice']);
    expect(hoisted.resolveArtistIds).toHaveBeenCalledTimes(1);
  });
});
