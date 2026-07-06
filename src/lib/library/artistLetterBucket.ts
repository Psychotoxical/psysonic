import type { SubsonicArtist } from '@/lib/api/subsonicTypes';

/** Catch-all bucket for names that start with neither an A–Z letter nor a digit. */
export const OTHER_BUCKET = 'OTHER';

/** Navidrome default (`IgnoredArticles` when the server omits the field). */
export const DEFAULT_IGNORED_ARTICLES = 'The El La Los Las Le Les Os As O A';

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
