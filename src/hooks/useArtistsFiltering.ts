import { useMemo } from 'react';
import type { SubsonicArtist } from '../api/subsonicTypes';
import { usePlayerStore } from '../store/playerStore';
import { ALL_SENTINEL, type ArtistListFlatRow } from '../utils/artistsHelpers';

interface UseArtistsFilteringArgs {
  artists: SubsonicArtist[];
  filter: string;
  letterFilter: string;
  starredOnly: boolean;
  visibleCount: number;
  viewMode: 'grid' | 'list';
}

interface UseArtistsFilteringResult {
  filtered: SubsonicArtist[];
  visible: SubsonicArtist[];
  hasMore: boolean;
  groups: Record<string, SubsonicArtist[]>;
  letters: string[];
  artistListFlatRows: ArtistListFlatRow[];
}

/**
 * Memoised filter + group pipeline for the artists page. Reading
 * `starredOverrides` here keeps the star-toggle reactive without
 * dragging the full player store through Artists.tsx props.
 *
 * Walking 5000+ artists per render was measurable — every cheap state
 * update (selection mode, view mode, page size) used to re-filter the
 * whole list. With this hook the three artist arrays
 * (filtered → visible → flat-rows) only recompute when their explicit
 * deps change.
 *
 * Group-by-letter and flat-row construction short-circuit when the user
 * is on the grid view, since neither output is needed there.
 */
export function useArtistsFiltering({
  artists,
  filter,
  letterFilter,
  starredOnly,
  visibleCount,
  viewMode,
}: UseArtistsFilteringArgs): UseArtistsFilteringResult {
  const starredOverrides = usePlayerStore(s => s.starredOverrides);

  const filtered = useMemo(() => {
    let out = artists;
    if (letterFilter !== ALL_SENTINEL) {
      out = out.filter(a => {
        const first = a.name[0]?.toUpperCase() ?? '#';
        const isAlpha = /^[A-Z]$/.test(first);
        if (letterFilter === '#') return !isAlpha;
        return first === letterFilter;
      });
    }
    if (filter) {
      const needle = filter.toLowerCase();
      out = out.filter(a => a.name.toLowerCase().includes(needle));
    }
    if (starredOnly) {
      out = out.filter(a => a.id in starredOverrides ? starredOverrides[a.id] : !!a.starred);
    }
    return out;
  }, [artists, letterFilter, filter, starredOnly, starredOverrides]);

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);
  const hasMore = visibleCount < filtered.length;

  const { groups, letters } = useMemo(() => {
    if (viewMode !== 'list') return { groups: {} as Record<string, SubsonicArtist[]>, letters: [] as string[] };
    const g: Record<string, SubsonicArtist[]> = {};
    for (const a of visible) {
      const letter = a.name[0]?.toUpperCase() ?? '#';
      const key = /^[A-Z]$/.test(letter) ? letter : '#';
      if (!g[key]) g[key] = [];
      g[key].push(a);
    }
    return { groups: g, letters: Object.keys(g).sort() };
  }, [visible, viewMode]);

  const artistListFlatRows = useMemo((): ArtistListFlatRow[] => {
    if (viewMode !== 'list') return [];
    const out: ArtistListFlatRow[] = [];
    for (const letter of letters) {
      out.push({ kind: 'letter', letter });
      const group = groups[letter];
      for (let i = 0; i < group.length; i++) {
        out.push({ kind: 'artist', artist: group[i], isLastInLetter: i === group.length - 1 });
      }
    }
    return out;
  }, [viewMode, letters, groups]);

  return { filtered, visible, hasMore, groups, letters, artistListFlatRows };
}
