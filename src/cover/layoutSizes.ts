import { computeCardGridColumnCount, computeCellWidthPx } from '../utils/cardGridLayout';

export const COVER_DENSE_SEARCH_CSS_PX = 40;
export const COVER_DENSE_ARTIST_LIST_CSS_PX = 64;
export const COVER_DENSE_RAIL_CELL_CSS_PX = 180;
export const COVER_DENSE_GRID_MIN_CELL_CSS_PX = 140;

export function coverDisplayCssPxForAlbumGrid(containerWidthPx: number, maxColumns: number): number {
  const cols = computeCardGridColumnCount(containerWidthPx, maxColumns);
  return Math.round(computeCellWidthPx(containerWidthPx, cols));
}
