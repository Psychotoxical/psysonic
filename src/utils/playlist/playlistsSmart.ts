export const SMART_PREFIX = 'psy-smart-';
export const LIMIT_MAX = 500;
export const YEAR_MIN = 1950;
export const YEAR_MAX = new Date().getFullYear() + 1;

export type GenreMode = 'include' | 'exclude';
export type YearMode = 'include' | 'exclude';

export type SmartFilters = {
  name: string;
  limit: string;
  sort: string;
  artistContains: string;
  albumContains: string;
  titleContains: string;
  minRating: number;
  excludeUnrated: boolean;
  compilationOnly: boolean;
  selectedGenres: string[];
  genreMode: GenreMode;
  yearFrom: number;
  yearTo: number;
  yearMode: YearMode;
};

export type PendingSmartPlaylist = {
  name: string;
  id?: string;
  firstSeenCoverArt?: string;
  attempts: number;
};

export type NdSmartRuleNode = Record<string, unknown>;

export const defaultSmartFilters: SmartFilters = {
  name: '',
  limit: '50',
  sort: '+random',
  artistContains: '',
  albumContains: '',
  titleContains: '',
  minRating: 0,
  excludeUnrated: false,
  compilationOnly: false,
  selectedGenres: [],
  genreMode: 'include',
  yearFrom: YEAR_MIN,
  yearTo: YEAR_MAX,
  yearMode: 'include',
};

export function clampYear(v: number): number {
  return Math.max(YEAR_MIN, Math.min(YEAR_MAX, v));
}

export function isSmartPlaylistName(name: string): boolean {
  return (name ?? '').toLowerCase().startsWith(SMART_PREFIX);
}

export function displayPlaylistName(name: string): string {
  const n = name ?? '';
  if (isSmartPlaylistName(n)) return n.slice(SMART_PREFIX.length);
  return n;
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseSmartRulesToFilters(
  rules: Record<string, unknown> | undefined,
  playlistName: string,
): SmartFilters {
  const next: SmartFilters = {
    ...defaultSmartFilters,
    name: displayPlaylistName(playlistName),
  };
  if (!rules) return next;

  if (typeof rules.limit === 'number' && Number.isFinite(rules.limit)) {
    next.limit = String(Math.max(1, Math.min(LIMIT_MAX, Number(rules.limit))));
  }
  if (typeof rules.sort === 'string' && rules.sort.trim()) next.sort = rules.sort;

  const includeGenres: string[] = [];
  const excludeGenres: string[] = [];
  const all = Array.isArray(rules.all) ? rules.all : [];
  for (const node of all) {
    const obj = asRecord(node);
    if (!obj) continue;

    const contains = asRecord(obj.contains);
    if (contains) {
      if (typeof contains.artist === 'string') next.artistContains = contains.artist;
      if (typeof contains.album === 'string') next.albumContains = contains.album;
      if (typeof contains.title === 'string') next.titleContains = contains.title;
    }

    const gt = asRecord(obj.gt);
    if (gt && typeof gt.rating === 'number') {
      if (gt.rating > 0) next.minRating = Math.max(0, Math.min(5, Math.floor(gt.rating)));
      else if (gt.rating === 0) next.excludeUnrated = true;
    }

    const is = asRecord(obj.is);
    if (is?.compilation === true) next.compilationOnly = true;

    const notContains = asRecord(obj.notContains);
    if (notContains && typeof notContains.genre === 'string') excludeGenres.push(notContains.genre);

    const inTheRange = asRecord(obj.inTheRange);
    if (inTheRange && Array.isArray(inTheRange.year) && inTheRange.year.length === 2) {
      const from = Number(inTheRange.year[0]);
      const to = Number(inTheRange.year[1]);
      if (Number.isFinite(from) && Number.isFinite(to)) {
        next.yearMode = 'include';
        next.yearFrom = clampYear(Math.min(from, to));
        next.yearTo = clampYear(Math.max(from, to));
      }
    }

    const any = Array.isArray(obj.any) ? (obj.any as NdSmartRuleNode[]) : [];
    if (any.length > 0) {
      const parsedGenreIncludes = any
        .map((item) => asRecord(asRecord(item)?.contains)?.genre)
        .filter((v): v is string => typeof v === 'string');
      if (parsedGenreIncludes.length > 0) includeGenres.push(...parsedGenreIncludes);

      const ltYear = any.map((item) => asRecord(asRecord(item)?.lt)?.year).find((v) => typeof v === 'number');
      const gtYear = any.map((item) => asRecord(asRecord(item)?.gt)?.year).find((v) => typeof v === 'number');
      if (typeof ltYear === 'number' && typeof gtYear === 'number') {
        next.yearMode = 'exclude';
        next.yearFrom = clampYear(Math.min(ltYear, gtYear));
        next.yearTo = clampYear(Math.max(ltYear, gtYear));
      }
    }
  }

  if (includeGenres.length > 0) {
    next.genreMode = 'include';
    next.selectedGenres = [...new Set(includeGenres)];
  } else if (excludeGenres.length > 0) {
    next.genreMode = 'exclude';
    next.selectedGenres = [...new Set(excludeGenres)];
  }

  return next;
}

export function buildSmartRulesPayload(filters: SmartFilters): Record<string, unknown> {
  const all: Record<string, unknown>[] = [];
  if (filters.artistContains.trim()) all.push({ contains: { artist: filters.artistContains.trim() } });
  if (filters.albumContains.trim()) all.push({ contains: { album: filters.albumContains.trim() } });
  if (filters.titleContains.trim()) all.push({ contains: { title: filters.titleContains.trim() } });

  const minRating = Number(filters.minRating);
  if (Number.isFinite(minRating) && minRating > 0) all.push({ gt: { rating: minRating } });
  else if (filters.excludeUnrated) all.push({ gt: { rating: 0 } });
  if (filters.compilationOnly) all.push({ is: { compilation: true } });

  if (filters.selectedGenres.length > 0) {
    if (filters.genreMode === 'include') {
      all.push({ any: filters.selectedGenres.map(v => ({ contains: { genre: v } })) });
    } else {
      for (const g of filters.selectedGenres) all.push({ notContains: { genre: g } });
    }
  }

  if (filters.yearMode === 'include') {
    all.push({ inTheRange: { year: [filters.yearFrom, filters.yearTo] } });
  } else {
    all.push({ any: [{ lt: { year: filters.yearFrom } }, { gt: { year: filters.yearTo } }] });
  }

  const rules: Record<string, unknown> = { all };
  rules.limit = Math.max(1, Math.min(LIMIT_MAX, Number(filters.limit) || 50));
  rules.sort = filters.sort;
  return rules;
}
