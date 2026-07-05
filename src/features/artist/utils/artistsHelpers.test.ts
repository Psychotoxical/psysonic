import { describe, expect, it } from 'vitest';
import {
  artistBucketKey,
  artistLetterBucket,
  compareBuckets,
  DEFAULT_IGNORED_ARTICLES,
  OTHER_BUCKET,
  ALPHABET,
  sortKeyFromDisplayName,
  stripLeadingArticles,
} from '@/features/artist/utils/artistsHelpers';

describe('stripLeadingArticles', () => {
  it('strips The from Beatles', () => {
    expect(stripLeadingArticles('The Beatles', DEFAULT_IGNORED_ARTICLES)).toBe('Beatles');
  });

  it('strips The from Kinks', () => {
    expect(stripLeadingArticles('The Kinks', DEFAULT_IGNORED_ARTICLES)).toBe('Kinks');
  });

  it('honours a custom ignoredArticles list', () => {
    expect(stripLeadingArticles('Los Lobos', 'Los')).toBe('Lobos');
  });
});

describe('sortKeyFromDisplayName', () => {
  it('strips articles and lowercases', () => {
    expect(sortKeyFromDisplayName('The Beatles')).toBe('beatles');
  });
});

describe('artistLetterBucket', () => {
  it('buckets a browse row by its display name, ignoring stale nameSort', () => {
    const artist = { id: '1', name: 'The Chemical Brothers', nameSort: 'the chemical brothers' };
    expect(artistLetterBucket(artist)).toBe('C');
  });

  it('uses a server ignoredArticles override when supplied', () => {
    const artist = { id: '2', name: 'Los Lobos' };
    expect(artistLetterBucket(artist, 'Los')).toBe('L');
  });
});

describe('screenshot T-filter artists (Navidrome article rules)', () => {
  it('keeps Theme/Tossers/Temper/Tiger under T after stripping The', () => {
    expect(artistBucketKey('The Theme Guys')).toBe('T');
    expect(artistBucketKey('The Tossers')).toBe('T');
    expect(artistBucketKey('The Temper Trap')).toBe('T');
    expect(artistBucketKey('The Tiger Lillies')).toBe('T');
    expect(artistBucketKey('TV Themes')).toBe('T');
    expect(artistBucketKey('Tribute To The N...')).toBe('T');
  });

  it('moves Beatles/Chemical/Cure/Doors out of T', () => {
    expect(artistBucketKey('The Beatles')).toBe('B');
    expect(artistBucketKey('The Chemical Brothers')).toBe('C');
    expect(artistBucketKey('The Cure')).toBe('C');
    expect(artistBucketKey('The Doors')).toBe('D');
    expect(artistBucketKey('The Fat Rat')).toBe('F');
  });

  it('keeps glued TheFatRat under T (no space after article — Navidrome parity)', () => {
    expect(artistBucketKey('TheFatRat')).toBe('T');
  });
});

describe('artistBucketKey', () => {
  it('buckets A–Z names by their uppercased first letter', () => {
    expect(artistBucketKey('Adele')).toBe('A');
    expect(artistBucketKey('zz top')).toBe('Z');
    expect(artistBucketKey('mGla')).toBe('M');
  });

  it('puts The Beatles under B', () => {
    expect(artistBucketKey('The Beatles')).toBe('B');
    expect(artistBucketKey('The Kinks')).toBe('K');
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
