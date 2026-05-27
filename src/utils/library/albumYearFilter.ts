import type { LibraryFilterClause } from '../../api/library';

export const ALBUM_YEAR_MIN = 1900;
export const ALBUM_YEAR_MAX = new Date().getFullYear();

export type AlbumYearBounds = { from?: number; to?: number };

export function parseAlbumYearField(raw: string): number | null {
  const n = parseInt(raw.trim(), 10);
  if (Number.isNaN(n) || n < 1) return null;
  return n;
}

export function resolveAlbumYearBounds(from: string, to: string): {
  active: boolean;
  bounds: AlbumYearBounds;
} {
  const fromN = parseAlbumYearField(from);
  const toN = parseAlbumYearField(to);
  if (fromN == null && toN == null) {
    return { active: false, bounds: {} };
  }
  return {
    active: true,
    bounds: {
      ...(fromN != null ? { from: fromN } : {}),
      ...(toN != null ? { to: toN } : {}),
    },
  };
}

export function formatAlbumYearFilterLabel(bounds: AlbumYearBounds): string | null {
  if (bounds.from != null && bounds.to != null) {
    const lo = Math.min(bounds.from, bounds.to);
    const hi = Math.max(bounds.from, bounds.to);
    return lo === hi ? String(lo) : `${lo}–${hi}`;
  }
  if (bounds.from != null) return `${bounds.from}–`;
  if (bounds.to != null) return `–${bounds.to}`;
  return null;
}

export function albumYearFilterClauses(bounds: AlbumYearBounds): LibraryFilterClause[] {
  const clauses: LibraryFilterClause[] = [];
  if (bounds.from != null && bounds.to != null) {
    const lo = Math.min(bounds.from, bounds.to);
    const hi = Math.max(bounds.from, bounds.to);
    clauses.push({ field: 'year', op: 'between', value: lo, valueTo: hi });
  } else if (bounds.from != null) {
    clauses.push({ field: 'year', op: 'gte', value: bounds.from });
  } else if (bounds.to != null) {
    clauses.push({ field: 'year', op: 'lte', value: bounds.to });
  }
  return clauses;
}

/** Params for Subsonic `getAlbumList2` `byYear` when the local index is unavailable. */
export function albumYearSubsonicParams(bounds: AlbumYearBounds): Record<string, number> {
  const out: Record<string, number> = {};
  if (bounds.from != null) out.fromYear = bounds.from;
  if (bounds.to != null) out.toYear = bounds.to;
  return out;
}
