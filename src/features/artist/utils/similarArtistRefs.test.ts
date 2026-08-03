import { describe, expect, it } from 'vitest';
import { similarArtistRefs } from './similarArtistRefs';

describe('similarArtistRefs', () => {
  it('stamps the server the info came from, not the active one', () => {
    // Browsing a scope whose artist is owned by srv-2 while srv-1 stays active: the ids
    // in this list are srv-2's, so pairing them with srv-1 would open the wrong artist.
    const refs = similarArtistRefs(
      [{ id: 'art-9', name: 'Neighbour', albumCount: 3 }],
      'srv-2',
      'srv-1',
    );
    expect(refs).toEqual([
      { id: 'art-9', name: 'Neighbour', albumCount: 3, serverId: 'srv-2' },
    ]);
  });

  it('falls back to the active server only when no owner was resolved', () => {
    const refs = similarArtistRefs([{ id: 'art-9', name: 'Neighbour' }], null, 'srv-1');
    expect(refs[0]?.serverId).toBe('srv-1');
  });

  it('keeps an entry that already names its own server', () => {
    const refs = similarArtistRefs(
      [{ id: 'art-9', name: 'Neighbour', serverId: 'srv-3' } as never],
      'srv-2',
      'srv-1',
    );
    expect(refs[0]?.serverId).toBe('srv-3');
  });

  it('returns nothing for a missing list', () => {
    expect(similarArtistRefs(undefined, 'srv-2', 'srv-1')).toEqual([]);
  });
});
