/**
 * Shared guard for local FTS and Subsonic search3.
 * - Wildcard-only tokens (`**`, `****`) match everything on search3 / FTS5.
 * - `=` and other query syntax break quoted FTS tokens (`1=2` → junk hits).
 * - Asterisks in real tags (`***Flawless`, `B********`) stay searchable.
 */

/** FTS5 / search3 syntax — not `*` (censorship stars in titles are valid). */
const FTS_QUERY_SYNTAX_CHARS = new Set(['=', ':', '(', ')', '^', '<', '>', '%', '|', '\\']);

function isWildcardOnlyToken(token: string): boolean {
  return token.length > 0 && [...token].every(ch => ch === '*');
}

export function searchTokenIsFtsSafe(token: string): boolean {
  const t = token.trim();
  if (!t || isWildcardOnlyToken(t)) return false;
  if ([...t].some(ch => FTS_QUERY_SYNTAX_CHARS.has(ch))) return false;
  return [...t].some(ch => /\p{L}|\p{N}/u.test(ch) || ch.charCodeAt(0) >= 0x80);
}

/** Every whitespace token must be safe — mirrors `fts_safe_whitespace_tokens` in Rust. */
export function searchQueryIsFtsSafe(query: string): boolean {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every(searchTokenIsFtsSafe);
}
