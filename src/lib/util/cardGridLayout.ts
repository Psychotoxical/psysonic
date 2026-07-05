/**
 * Shared responsive card grids: capped columns, even stretch (`minmax(0, 1fr)`),
 * and row-height estimates derived from measured cell width (TanStack virtual rows).
 */

// Library grid column config. Owned here (pure layout math) and re-exported by
// authStoreDefaults, which clamps/defaults the user's libraryGridMaxColumns
// setting against them — keeps this module store-free so ui/ + cover/ can use it.
export const DEFAULT_LIBRARY_GRID_MAX_COLUMNS = 6;
export const LIBRARY_GRID_MAX_COLUMNS_MIN = 4;
export const LIBRARY_GRID_MAX_COLUMNS_MAX = 12;

export const CARD_GRID_GAP_PX = 16;
export const CARD_GRID_MIN_TILE_PX = 140;

/** @deprecated use `DEFAULT_LIBRARY_GRID_MAX_COLUMNS` */
export const CARD_GRID_MAX_COLS = DEFAULT_LIBRARY_GRID_MAX_COLUMNS;

export function computeCardGridColumnCount(containerWidthPx: number, maxColumns: number): number {
  const cap = Math.max(
    LIBRARY_GRID_MAX_COLUMNS_MIN,
    Math.min(LIBRARY_GRID_MAX_COLUMNS_MAX, Math.round(maxColumns)),
  );
  const raw = Math.floor(
    (containerWidthPx + CARD_GRID_GAP_PX) / (CARD_GRID_MIN_TILE_PX + CARD_GRID_GAP_PX),
  );
  return Math.min(cap, Math.max(1, raw));
}

export function computeCellWidthPx(containerWidthPx: number, columnCount: number): number {
  const c = Math.max(1, columnCount);
  return (containerWidthPx - (c - 1) * CARD_GRID_GAP_PX) / c;
}

export type CardGridRowHeightVariant = 'artist' | 'album' | 'playlist' | 'offline' | 'composer';

const VARIANT: Record<CardGridRowHeightVariant, { extra: number; min: number; max: number }> = {
  artist: { extra: 72, min: 200, max: 520 },
  /** Cover scales with cell width; ~108px headroom matches prior ~288px row at ~180px tiles. */
  album: { extra: 108, min: 260, max: 560 },
  playlist: { extra: 108, min: 260, max: 560 },
  /** Offline Library cards: album metadata + track-count footer + row gap in virtual rows. */
  offline: { extra: 140, min: 290, max: 580 },
  /** Text-only composer tiles: no imagery → fixed intrinsic height, does not
   * scale with cell width like the image variants. min === max pins it. */
  composer: { extra: 0, min: 88, max: 88 },
};

export function estimateRowHeightPx(cellWidthPx: number, variant: CardGridRowHeightVariant): number {
  const { extra, min, max } = VARIANT[variant];
  return Math.max(min, Math.min(max, Math.ceil(cellWidthPx + extra)));
}
