import { computeCardGridColumnCount, computeCellWidthPx } from '@/lib/util/cardGridLayout';

export const COVER_DENSE_SEARCH_CSS_PX = 40;
/** Artist detail top-track thumb (32×32 CSS px). */
export const COVER_ARTIST_TOP_TRACK_CSS_PX = 32;
export const COVER_DENSE_ARTIST_LIST_CSS_PX = 64;
export const COVER_DENSE_RAIL_CELL_CSS_PX = 180;
export const COVER_DENSE_GRID_MIN_CELL_CSS_PX = 140;

export function coverDisplayCssPxForAlbumGrid(containerWidthPx: number, maxColumns: number): number {
  const cols = computeCardGridColumnCount(containerWidthPx, maxColumns);
  return Math.round(computeCellWidthPx(containerWidthPx, cols));
}

export const GRID_COVER_WARM_LIMIT = 120;

/** Bounded album grids (Random Albums, paginated slice, …) — prime HTTP ensures after peek. */
export const GRID_COVER_PRIME_ALL_MAX = 48;

/** Props for `VirtualCardGrid` `warmGridCovers` on album-style pages. */
export function albumGridWarmCovers<T extends { coverArt?: string | null }>(
  displayCssPx: number = COVER_DENSE_GRID_MIN_CELL_CSS_PX,
  limit: number = GRID_COVER_WARM_LIMIT,
) {
  return {
    pickCoverArtId: (item: T) => item.coverArt,
    displayCssPx,
    limit,
  };
}
