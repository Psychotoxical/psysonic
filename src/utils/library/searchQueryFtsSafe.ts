/**
 * Shared guard for local FTS and Subsonic search3 — tokens with FTS5 / server
 * wildcard syntax (`=`, `*`, …) produce unrelated hits (see Rust `fts_token_is_safe`).
 */

const FTS_UNSAFE_TOKEN_CHARS = new Set(['=', ':', '*', '(', ')', '^', '<', '>', '%', '|', '\\']);

export function searchTokenIsFtsSafe(token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  if ([...t].some(ch => FTS_UNSAFE_TOKEN_CHARS.has(ch))) return false;
  return [...t].some(ch => /\p{L}|\p{N}/u.test(ch) || ch.charCodeAt(0) >= 0x80);
}

/** Every whitespace token must be safe — mirrors `fts_safe_whitespace_tokens` in Rust. */
export function searchQueryIsFtsSafe(query: string): boolean {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every(searchTokenIsFtsSafe);
}
