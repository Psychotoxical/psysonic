import { describe, expect, it } from 'vitest';
import {
  albumYearFilterClauses,
  albumYearSubsonicParams,
  clampAlbumYearFieldInput,
  formatAlbumYearFilterLabel,
  normalizeAlbumYearToFieldChange,
  resolveAlbumYearBounds,
  stepAlbumYearField,
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
  const catalog = { min: 1975, max: 2020 };

  it('formats partial ranges using catalog edges', () => {
    expect(formatAlbumYearFilterLabel({ from: 1990 }, catalog)).toBe('1990–2020');
    expect(formatAlbumYearFilterLabel({ to: 2000 }, catalog)).toBe('1975–2000');
    expect(formatAlbumYearFilterLabel({ from: 2000, to: 2010 }, catalog)).toBe('2000–2010');
  });

  it('collapses when the only bound equals the implied catalog edge', () => {
    expect(formatAlbumYearFilterLabel({ from: 2020 }, catalog)).toBe('2020');
    expect(formatAlbumYearFilterLabel({ to: 1975 }, catalog)).toBe('1975');
  });
});

describe('albumYearSubsonicParams', () => {
  it('omits unset bounds', () => {
    expect(albumYearSubsonicParams({ from: 1995 })).toEqual({ fromYear: 1995 });
    expect(albumYearSubsonicParams({ to: 2010 })).toEqual({ toYear: 2010 });
  });
});

describe('album year spinner helpers', () => {
  const min = 1975;
  const max = 2020;

  it('steps from field from catalog min when empty', () => {
    expect(stepAlbumYearField('', 1, min, max, 'min')).toBe('1976');
    expect(stepAlbumYearField('', 0, min, max, 'min')).toBe('1975');
  });

  it('steps to field from catalog max when empty', () => {
    expect(stepAlbumYearField('', -1, min, max, 'max')).toBe('2019');
    expect(stepAlbumYearField('', 0, min, max, 'max')).toBe('2020');
  });

  it('clamps typed values to catalog bounds', () => {
    expect(clampAlbumYearFieldInput('1960', min, max)).toBe('1975');
    expect(clampAlbumYearFieldInput('2030', min, max)).toBe('2020');
  });

  it('maps first native spinner tick on empty to field to max', () => {
    expect(normalizeAlbumYearToFieldChange('', '1975', min, max)).toBe('2020');
    expect(normalizeAlbumYearToFieldChange('2010', '1975', min, max)).toBe('1975');
  });
});
