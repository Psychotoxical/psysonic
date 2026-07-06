import type { SubsonicArtist } from '@/lib/api/subsonicTypes';
import {
  DEFAULT_IGNORED_ARTICLES,
  OTHER_BUCKET,
  artistBucketKey,
  artistLetterBucket,
  sortKeyFromDisplayName,
  stripLeadingArticles,
} from '@/lib/library/artistLetterBucket';

export {
  DEFAULT_IGNORED_ARTICLES,
  OTHER_BUCKET,
  artistBucketKey,
  artistLetterBucket,
  sortKeyFromDisplayName,
  stripLeadingArticles,
};

export const ALL_SENTINEL = 'ALL';
export const ALPHABET = [ALL_SENTINEL, '#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''), OTHER_BUCKET];

/** Stable ordering index for a bucket key — '#' first, A–Z, then 'Other' last. */
const BUCKET_ORDER = new Map(ALPHABET.map((l, i) => [l, i]));

/** Sort comparator for bucket keys following ALPHABET order (unknown keys last). */
export function compareBuckets(a: string, b: string): number {
  return (BUCKET_ORDER.get(a) ?? 999) - (BUCKET_ORDER.get(b) ?? 999);
}

/** Virtual row height guesses — letter heading vs dense rows vs last row in section (group gap). */
export const ARTIST_LIST_LETTER_ROW_EST = 48;
export const ARTIST_LIST_ROW_EST = 64;
export const ARTIST_LIST_LAST_IN_LETTER_EST = 88;

export type ArtistListFlatRow =
  | { kind: 'letter'; letter: string }
  | { kind: 'artist'; artist: SubsonicArtist; isLastInLetter: boolean };

// Catppuccin accent colors — one is picked deterministically from the artist name
const CTP_COLORS = [
  'var(--ctp-rosewater)', 'var(--ctp-flamingo)', 'var(--ctp-pink)',    'var(--ctp-mauve)',
  'var(--ctp-red)',       'var(--ctp-maroon)',    'var(--ctp-peach)',   'var(--ctp-yellow)',
  'var(--ctp-green)',     'var(--ctp-teal)',      'var(--ctp-sky)',     'var(--ctp-sapphire)',
  'var(--ctp-blue)',      'var(--ctp-lavender)',
];

export function nameColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CTP_COLORS[h % CTP_COLORS.length];
}

export function nameInitial(name: string): string {
  // \p{L} matches any Unicode letter — covers cyrillic, arabic, CJK, etc.
  const letter = name.match(/\p{L}/u)?.[0];
  if (letter) return letter.toUpperCase();
  const alnum = name.match(/[0-9]/)?.[0];
  return alnum ?? '?';
}
