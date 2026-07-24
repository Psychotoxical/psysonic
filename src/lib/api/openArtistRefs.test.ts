import { describe, expect, it } from 'vitest';
import {
  coerceOpenArtistRefs,
  displayArtistRefs,
  splitDisplayArtistName,
} from '@/lib/api/openArtistRefs';

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

describe('splitDisplayArtistName', () => {
  it('splits on every separator the server uses, case-insensitively', () => {
    expect(splitDisplayArtistName('Alice feat. Bob')).toEqual(['Alice', 'Bob']);
    expect(splitDisplayArtistName('Alice FEAT. Bob')).toEqual(['Alice', 'Bob']);
    expect(splitDisplayArtistName('Alice feat Bob')).toEqual(['Alice', 'Bob']);
    expect(splitDisplayArtistName('Alice ft. Bob')).toEqual(['Alice', 'Bob']);
    expect(splitDisplayArtistName('Alice ft Bob')).toEqual(['Alice', 'Bob']);
    expect(splitDisplayArtistName('Alice / Bob')).toEqual(['Alice', 'Bob']);
    expect(splitDisplayArtistName('Alice; Bob')).toEqual(['Alice', 'Bob']);
  });

  it('splits a credit with several guests', () => {
    expect(splitDisplayArtistName('Alice feat. Bob / Carol')).toEqual(['Alice', 'Bob', 'Carol']);
  });

  // Both of these are explicit in the server's tagging spec — relaxing either rule
  // would break real artist names.
  it('keeps a slash without surrounding spaces intact', () => {
    expect(splitDisplayArtistName('AC/DC')).toEqual(['AC/DC']);
  });

  it('does not treat a comma as a separator', () => {
    expect(splitDisplayArtistName('Daniel Hope, Konzerthaus Kammerorchester Berlin'))
      .toEqual(['Daniel Hope, Konzerthaus Kammerorchester Berlin']);
  });

  it('does not split a name that merely contains a separator word', () => {
    expect(splitDisplayArtistName('Fatboy Slim')).toEqual(['Fatboy Slim']);
    expect(splitDisplayArtistName('Left of Center')).toEqual(['Left of Center']);
  });

  it('returns nothing for empty input', () => {
    expect(splitDisplayArtistName(undefined)).toEqual([]);
    expect(splitDisplayArtistName('   ')).toEqual([]);
  });
});

describe('displayArtistRefs', () => {
  it('keeps the id on the primary artist only', () => {
    expect(displayArtistRefs('Alice feat. Bob', 'ar-alice')).toEqual([
      { id: 'ar-alice', name: 'Alice' },
      { name: 'Bob' },
    ]);
  });

  it('returns one ref with the id when there is nothing to split', () => {
    expect(displayArtistRefs('Alice', 'ar-alice')).toEqual([{ id: 'ar-alice', name: 'Alice' }]);
  });

  it('omits the id when the server gave none', () => {
    expect(displayArtistRefs('Alice feat. Bob')).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
  });
});
