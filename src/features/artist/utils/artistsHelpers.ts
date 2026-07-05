import type { SubsonicArtist } from '@/lib/api/subsonicTypes';

export const ALL_SENTINEL = 'ALL';
/** Catch-all bucket for names that start with neither an A–Z letter nor a digit
 *  (accented Latin like Æ/Ø/Å, and non-Latin scripts: CJK, Cyrillic, …). */
export const OTHER_BUCKET = 'OTHER';
export const ALPHABET = [ALL_SENTINEL, '#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''), OTHER_BUCKET];

/** Navidrome default (`IgnoredArticles` when the server omits the field). */
export const DEFAULT_IGNORED_ARTICLES = 'The El La Los Las Le Les Os As O A';

/** Stable ordering index for a bucket key — '#' first, A–Z, then 'Other' last. */
const BUCKET_ORDER = new Map(ALPHABET.map((l, i) => [l, i]));

/** Strip leading articles for sort/bucket keys (Navidrome `RemoveArticle` parity). */
export function stripLeadingArticles(
  name: string,
  ignoredArticles = DEFAULT_IGNORED_ARTICLES,
): string {
  const trimmed = name.trim();
  for (const article of ignoredArticles.split(' ').filter(Boolean)) {
    const prefix = `${article} `;
    if (
      trimmed.length >= prefix.length
      && trimmed.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
    ) {
      return trimmed.slice(prefix.length).trimStart();
    }
  }
  return trimmed;
}

/** Sort key from display name — article strip + lowercase (Navidrome parity). */
export function sortKeyFromDisplayName(
  displayName: string,
  ignoredArticles?: string | null,
): string {
  const articles = ignoredArticles?.trim() || DEFAULT_IGNORED_ARTICLES;
  return stripLeadingArticles(displayName, articles).toLowerCase();
}

/**
 * Bucket an artist name into the alphabet index (after article stripping):
 *  - `#`      → starts with a digit (0–9)
 *  - `A`–`Z`  → starts with an ASCII letter on the sort key
 *  - `OTHER`  → anything else (accents, CJK, Cyrillic, symbols, empty)
 *
 * Buckets always derive from the display `name` + `ignoredArticles`, never the
 * persisted `nameSort` (which can lag a renamed artist until the next reconcile).
 */
export function artistBucketKey(
  name: string,
  ignoredArticles?: string | null,
): string {
  const sortKey = sortKeyFromDisplayName(name, ignoredArticles);
  const first = sortKey?.[0];
  if (!first) return OTHER_BUCKET;
  if (/^[0-9]$/.test(first)) return '#';
  const up = first.toUpperCase();
  return /^[A-Z]$/.test(up) ? up : OTHER_BUCKET;
}

/** Letter bucket for a browse row — uses the server's `ignoredArticles` when known. */
export function artistLetterBucket(
  artist: SubsonicArtist,
  ignoredArticles?: string | null,
): string {
  return artistBucketKey(artist.name, ignoredArticles);
}

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
