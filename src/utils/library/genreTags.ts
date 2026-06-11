import type { SubsonicAlbum, SubsonicItemGenre, SubsonicSong } from '../../api/subsonicTypes';

const GENRE_SEPARATORS = [';', '/', ','] as const;

function dedupeGenres(genres: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of genres) {
    const t = g.trim();
    if (!t) continue;
    const key = t.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Parse OpenSubsonic `genres` from a raw API payload fragment. */
export function parseItemGenres(raw: unknown): SubsonicItemGenre[] | undefined {
  if (raw == null) return undefined;
  const items = Array.isArray(raw) ? raw : [raw];
  if (items.length === 0) return undefined;
  const names: string[] = [];
  for (const item of items) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const name = (item as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim()) names.push(name.trim());
    } else if (typeof item === 'string' && item.trim()) {
      names.push(item.trim());
    }
  }
  const deduped = dedupeGenres(names);
  return deduped.length > 0 ? deduped.map(name => ({ name })) : undefined;
}

/** Navidrome-default split when the server sent no `genres[]` array. */
export function splitGenreTags(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  let parts = [trimmed];
  for (const sep of GENRE_SEPARATORS) {
    const next: string[] = [];
    for (const part of parts) {
      for (const sub of part.split(sep)) next.push(sub);
    }
    parts = next;
  }
  return dedupeGenres(parts);
}

type GenreTagSource = Pick<SubsonicSong | SubsonicAlbum, 'genre'> & {
  /** Runtime shape may be ItemGenre[], a single object, or bare strings (Subsonic JSON). */
  genres?: unknown;
};

/** Server-authoritative genres when present; otherwise split the legacy `genre` string. */
export function genreTagsFor(item: GenreTagSource): string[] {
  const parsed = parseItemGenres(item.genres);
  if (parsed && parsed.length > 0) {
    return dedupeGenres(parsed.map(g => g.name));
  }
  const g = item.genre?.trim();
  return g ? splitGenreTags(g) : [];
}
