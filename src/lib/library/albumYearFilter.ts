import type { LibraryFilterClause } from '@/lib/api/library';

export const ALBUM_YEAR_MIN = 1900;
export const ALBUM_YEAR_MAX = new Date().getFullYear();
/** Delay before year filter triggers album browse reload. */
export const ALBUM_YEAR_FILTER_DEBOUNCE_MS = 350;

export type AlbumCatalogYearRange = { min: number; max: number };

export function clampAlbumYear(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Spinner / wheel step; empty field starts at `startEdge` of the catalog range. */
export function stepAlbumYearField(
  raw: string,
  delta: number,
  min: number,
  max: number,
  startEdge: 'min' | 'max',
): string {
  const start = startEdge === 'min' ? min : max;
  const current = raw.trim() ? (parseAlbumYearField(raw) ?? start) : start;
  return String(clampAlbumYear(current + delta, min, max));
}

export function clampAlbumYearFieldInput(
  raw: string,
  min: number,
  max: number,
): string {
  if (!raw.trim()) return '';
  const n = parseAlbumYearField(raw);
  if (n == null) return '';
  return String(clampAlbumYear(n, min, max));
}

/** Native number spinners jump to `min` from empty — map the "to" field to catalog max. */
export function normalizeAlbumYearToFieldChange(
  prevTo: string,
  nextRaw: string,
  catalogMin: number,
  catalogMax: number,
): string {
  if (!prevTo.trim() && nextRaw === String(catalogMin) && catalogMin !== catalogMax) {
    return String(catalogMax);
  }
  return clampAlbumYearFieldInput(nextRaw, catalogMin, catalogMax);
}

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

/** Chip label; open-ended bounds show catalog (or default) min/max on the missing side. */
export function formatAlbumYearFilterLabel(
  bounds: AlbumYearBounds,
  catalog?: AlbumCatalogYearRange,
): string | null {
  const catalogMin = catalog?.min ?? ALBUM_YEAR_MIN;
  const catalogMax = catalog?.max ?? ALBUM_YEAR_MAX;

  if (bounds.from != null && bounds.to != null) {
    const lo = Math.min(bounds.from, bounds.to);
    const hi = Math.max(bounds.from, bounds.to);
    return lo === hi ? String(lo) : `${lo}–${hi}`;
  }
  if (bounds.from != null) {
    const hi = catalogMax;
    return bounds.from === hi ? String(bounds.from) : `${bounds.from}–${hi}`;
  }
  if (bounds.to != null) {
    const lo = catalogMin;
    return bounds.to === lo ? String(bounds.to) : `${lo}–${bounds.to}`;
  }
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
