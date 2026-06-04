import { describe, expect, it } from 'vitest';
import { searchQueryIsFtsSafe, searchTokenIsFtsSafe } from './searchQueryFtsSafe';

describe('searchQueryIsFtsSafe', () => {
  it('rejects equals and wildcard-only junk queries', () => {
    expect(searchQueryIsFtsSafe('1=2')).toBe(false);
    expect(searchQueryIsFtsSafe('**')).toBe(false);
    expect(searchQueryIsFtsSafe('***')).toBe(false);
    expect(searchQueryIsFtsSafe('****')).toBe(false);
    expect(searchQueryIsFtsSafe('M=c')).toBe(false);
    expect(searchQueryIsFtsSafe('V()>P')).toBe(false);
  });

  it('accepts normal search terms and censorship stars in titles', () => {
    expect(searchQueryIsFtsSafe('metallica')).toBe(true);
    expect(searchQueryIsFtsSafe('love supreme')).toBe(true);
    expect(searchQueryIsFtsSafe('25')).toBe(true);
    expect(searchQueryIsFtsSafe('AC/DC')).toBe(true);
    expect(searchQueryIsFtsSafe('***Flawless')).toBe(true);
    expect(searchQueryIsFtsSafe('B********')).toBe(true);
    expect(searchQueryIsFtsSafe('F**k This Industry')).toBe(true);
  });

  it('rejects when any token is unsafe', () => {
    expect(searchQueryIsFtsSafe('dark side')).toBe(true);
    expect(searchQueryIsFtsSafe('dark = side')).toBe(false);
  });
});

describe('searchTokenIsFtsSafe', () => {
  it('requires at least one letter or digit', () => {
    expect(searchTokenIsFtsSafe('***')).toBe(false);
    expect(searchTokenIsFtsSafe('!!!')).toBe(false);
  });
});
