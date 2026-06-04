import { describe, expect, it } from 'vitest';
import { artistBucketKey, compareBuckets, OTHER_BUCKET, ALPHABET } from './artistsHelpers';

describe('artistBucketKey', () => {
  it('buckets A–Z names by their uppercased first letter', () => {
    expect(artistBucketKey('Adele')).toBe('A');
    expect(artistBucketKey('zz top')).toBe('Z');
    expect(artistBucketKey('mGla')).toBe('M');
  });

  it('puts digit-leading names in #', () => {
    expect(artistBucketKey('2Pac')).toBe('#');
    expect(artistBucketKey('50 Cent')).toBe('#');
    expect(artistBucketKey('999')).toBe('#');
  });

  it('puts accented Latin and non-Latin scripts in Other (not #)', () => {
    expect(artistBucketKey('Ärzte')).toBe(OTHER_BUCKET);
    expect(artistBucketKey('Øde')).toBe(OTHER_BUCKET);
    expect(artistBucketKey('Å-band')).toBe(OTHER_BUCKET);
    expect(artistBucketKey('이영지')).toBe(OTHER_BUCKET);   // Korean
    expect(artistBucketKey('くるり')).toBe(OTHER_BUCKET);   // Japanese
    expect(artistBucketKey('Кино')).toBe(OTHER_BUCKET);    // Cyrillic
    expect(artistBucketKey('王菲')).toBe(OTHER_BUCKET);     // Chinese
  });

  it('puts symbol-leading and empty names in Other', () => {
    expect(artistBucketKey('!!!')).toBe(OTHER_BUCKET);
    expect(artistBucketKey('   ')).toBe(OTHER_BUCKET);
    expect(artistBucketKey('')).toBe(OTHER_BUCKET);
  });

  it('ignores leading whitespace', () => {
    expect(artistBucketKey('  Beatles')).toBe('B');
  });
});

describe('compareBuckets', () => {
  it('orders # first, then A–Z, then Other last', () => {
    const shuffled = ['OTHER', 'M', '#', 'A', 'Z'];
    expect([...shuffled].sort(compareBuckets)).toEqual(['#', 'A', 'M', 'Z', 'OTHER']);
  });

  it('ALPHABET ends with the Other bucket', () => {
    expect(ALPHABET[ALPHABET.length - 1]).toBe(OTHER_BUCKET);
    expect(ALPHABET).toContain('#');
  });
});
