import { describe, expect, it } from 'vitest';
import type { SearchResults } from '@/lib/api/subsonicTypes';
import { raceLiveSearch, type LiveSearchRaceSettled } from './searchRace';

const empty: SearchResults = { artists: [], albums: [], songs: [] };
const localHits: SearchResults = {
  artists: [{ id: 'a1', name: 'Local' }],
  albums: [],
  songs: [],
};
const networkHits: SearchResults = {
  artists: [{ id: 'a2', name: 'Network' }],
  albums: [],
  songs: [],
};

describe('raceLiveSearch', () => {
  it('network wins when it returns hits first', async () => {
    const winner = await raceLiveSearch(
      () =>
        new Promise<SearchResults | null>(resolve => {
          setTimeout(() => resolve(localHits), 40);
        }),
      async () => networkHits,
      () => false,
    );
    expect(winner?.source).toBe('network');
  });

  it('waits for network when local is empty', async () => {
    const winner = await raceLiveSearch(
      async () => empty,
      async () => networkHits,
      () => false,
    );
    expect(winner?.source).toBe('network');
  });

  it('local wins when network is empty and local has hits', async () => {
    const winner = await raceLiveSearch(
      async () => localHits,
      async () => empty,
      () => false,
    );
    expect(winner?.source).toBe('local');
  });

  it('waits for local when network is empty', async () => {
    const winner = await raceLiveSearch(
      () =>
        new Promise<SearchResults | null>(resolve => {
          setTimeout(() => resolve(localHits), 30);
        }),
      async () => empty,
      () => false,
    );
    expect(winner?.source).toBe('local');
  });

  it('does not pick empty local before network returns hits', async () => {
    const winner = await raceLiveSearch(
      async () => empty,
      () =>
        new Promise<SearchResults | null>(resolve => {
          setTimeout(() => resolve(networkHits), 30);
        }),
      () => false,
    );
    expect(winner?.source).toBe('network');
  });

  it('calls onSettled with both runner timings', async () => {
    let settled: LiveSearchRaceSettled | null = null;
    await raceLiveSearch(
      async () => localHits,
      async () => networkHits,
      () => false,
      meta => {
        settled = meta;
      },
    );
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });
    expect(settled).not.toBeNull();
    expect(settled!.localHits).toBe('1/0/0');
    expect(settled!.networkHits).toBe('1/0/0');
    expect(settled!.localMs).toBeGreaterThanOrEqual(0);
    expect(settled!.networkMs).toBeGreaterThanOrEqual(0);
  });
});
