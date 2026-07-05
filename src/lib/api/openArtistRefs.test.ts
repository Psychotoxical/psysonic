import { describe, expect, it } from 'vitest';
import { coerceOpenArtistRefs } from '@/lib/api/openArtistRefs';

describe('coerceOpenArtistRefs', () => {
  it('returns an empty array for nullish input', () => {
    expect(coerceOpenArtistRefs(undefined)).toEqual([]);
    expect(coerceOpenArtistRefs(null)).toEqual([]);
  });

  it('passes through arrays', () => {
    const refs = [{ id: 'a1', name: 'One' }, { id: 'a2', name: 'Two' }];
    expect(coerceOpenArtistRefs(refs)).toBe(refs);
  });

  it('wraps a single ref object from Subsonic JSON', () => {
    const ref = { id: 'a1', name: 'Solo' };
    expect(coerceOpenArtistRefs(ref)).toEqual([ref]);
  });
});
