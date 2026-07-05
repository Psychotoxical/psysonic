import { describe, expect, it } from 'vitest';
import { raceSearchSources } from './searchRace';

type RacePayload = { id: string };

describe('raceSearchSources', () => {
  it('returns the first non-null result', async () => {
    const winner = await raceSearchSources<RacePayload>(
      [
        {
          source: 'local',
          run: () =>
            new Promise<RacePayload | null>(resolve => {
              setTimeout(() => resolve({ id: 'local' }), 30);
            }),
        },
        {
          source: 'network',
          run: () =>
            new Promise<RacePayload | null>(resolve => {
              setTimeout(() => resolve({ id: 'network' }), 5);
            }),
        },
      ],
      () => false,
    );
    expect(winner?.source).toBe('network');
    expect(winner?.result).toEqual({ id: 'network' });
  });

  it('waits for network when local returns null', async () => {
    const winner = await raceSearchSources<RacePayload>(
      [
        { source: 'local', run: async () => null },
        {
          source: 'network',
          run: async () => ({ id: 'network' }),
        },
      ],
      () => false,
    );
    expect(winner?.source).toBe('network');
  });

  it('returns null when every runner returns null', async () => {
    await expect(
      raceSearchSources<RacePayload>(
        [
          { source: 'local', run: async () => null },
          { source: 'network', run: async () => null },
        ],
        () => false,
      ),
    ).resolves.toBeNull();
  });

  it('rejects when all runners fail', async () => {
    await expect(
      raceSearchSources<RacePayload>(
        [
          { source: 'local', run: async () => { throw new Error('local boom'); } },
          { source: 'network', run: async () => { throw new Error('network boom'); } },
        ],
        () => false,
      ),
    ).rejects.toThrow('local boom');
  });

  it('succeeds when one runner fails and another returns data', async () => {
    const winner = await raceSearchSources<{ ok: boolean }>(
      [
        { source: 'local', run: async () => { throw new Error('local boom'); } },
        { source: 'network', run: async () => ({ ok: true }) },
      ],
      () => false,
    );
    expect(winner?.source).toBe('network');
  });

  it('does not resolve after isStale becomes true', async () => {
    let stale = false;
    const winnerPromise = raceSearchSources<RacePayload>(
      [
        {
          source: 'local',
          run: () =>
            new Promise<RacePayload | null>(resolve => {
              setTimeout(() => {
                stale = true;
                resolve({ id: 'late' });
              }, 10);
            }),
        },
        { source: 'network', run: async () => null },
      ],
      () => stale,
    );
    await expect(winnerPromise).resolves.toBeNull();
  });
});
