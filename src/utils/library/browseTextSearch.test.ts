import { describe, expect, it } from 'vitest';
import { browseRaceCountsArtists, raceBrowseWithLocalFallback } from './browseTextSearch';

describe('raceBrowseWithLocalFallback', () => {
  it('returns local when network throws and local has data', async () => {
    const outcome = await raceBrowseWithLocalFallback(
      () => false,
      async () => [{ id: 'a1', name: 'Local Artist' }],
      async () => {
        throw new Error('server down');
      },
      {
        surface: 'artists_browse',
        query: 'test',
        counts: browseRaceCountsArtists,
      },
    );
    expect(outcome?.source).toBe('local');
    expect(outcome?.result).toHaveLength(1);
  });

  it('falls back to local after race when network was faster but returned null', async () => {
    let localCalls = 0;
    const outcome = await raceBrowseWithLocalFallback(
      () => false,
      async () => {
        localCalls += 1;
        return localCalls >= 2 ? ['hit'] : null;
      },
      async () => null,
    );
    expect(outcome?.source).toBe('local');
    expect(outcome?.result).toEqual(['hit']);
  });

  it('returns network when local is unavailable', async () => {
    const outcome = await raceBrowseWithLocalFallback(
      () => false,
      async () => null,
      async () => ['network'],
    );
    expect(outcome?.source).toBe('network');
    expect(outcome?.result).toEqual(['network']);
  });
});
