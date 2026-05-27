import { describe, expect, it } from 'vitest';
import {
  albumYearFilterClauses,
  albumYearSubsonicParams,
  formatAlbumYearFilterLabel,
  resolveAlbumYearBounds,
} from './albumYearFilter';

describe('resolveAlbumYearBounds', () => {
  it('is inactive when both fields are empty', () => {
    expect(resolveAlbumYearBounds('', '')).toEqual({ active: false, bounds: {} });
  });

  it('is active with only from', () => {
    expect(resolveAlbumYearBounds('1990', '')).toEqual({
      active: true,
      bounds: { from: 1990 },
    });
  });

  it('is active with only to', () => {
    expect(resolveAlbumYearBounds('', '2005')).toEqual({
      active: true,
      bounds: { to: 2005 },
    });
  });

  it('is active with both bounds', () => {
    expect(resolveAlbumYearBounds('1980', '1999')).toEqual({
      active: true,
      bounds: { from: 1980, to: 1999 },
    });
  });
});

describe('albumYearFilterClauses', () => {
  it('uses gte for open-ended from', () => {
    expect(albumYearFilterClauses({ from: 2000 })).toEqual([
      { field: 'year', op: 'gte', value: 2000 },
    ]);
  });

  it('uses lte for open-ended to', () => {
    expect(albumYearFilterClauses({ to: 2010 })).toEqual([
      { field: 'year', op: 'lte', value: 2010 },
    ]);
  });
});

describe('formatAlbumYearFilterLabel', () => {
  it('formats partial ranges', () => {
    expect(formatAlbumYearFilterLabel({ from: 1990 })).toBe('1990–');
    expect(formatAlbumYearFilterLabel({ to: 2000 })).toBe('–2000');
    expect(formatAlbumYearFilterLabel({ from: 2000, to: 2010 })).toBe('2000–2010');
  });
});

describe('albumYearSubsonicParams', () => {
  it('omits unset bounds', () => {
    expect(albumYearSubsonicParams({ from: 1995 })).toEqual({ fromYear: 1995 });
    expect(albumYearSubsonicParams({ to: 2010 })).toEqual({ toYear: 2010 });
  });
});
