import { describe, expect, it } from 'vitest';
import { computeCardGridColumnCount, estimateRowHeightPx } from '@/lib/util/cardGridLayout';
import { LIBRARY_GRID_MAX_COLUMNS_MAX, LIBRARY_GRID_MAX_COLUMNS_MIN } from '@/store/authStoreDefaults';

describe('estimateRowHeightPx', () => {
  describe('composer variant', () => {
    // Composer tiles are text-only — they do not carry imagery that scales
    // with cell width. Reverting this to `cellWidthPx + extra` would re-open
    // the "200 px reserved per virtual row vs. ~78 px actual card" gap that
    // left empty space between every Composers grid row.
    it('returns a fixed height regardless of cell width', () => {
      expect(estimateRowHeightPx(40, 'composer')).toBe(88);
      expect(estimateRowHeightPx(150, 'composer')).toBe(88);
      expect(estimateRowHeightPx(400, 'composer')).toBe(88);
      expect(estimateRowHeightPx(2_000, 'composer')).toBe(88);
    });
  });

  describe('image variants scale with cell width', () => {
    it('artist grows roughly linearly with cell width, clamped to its band', () => {
      expect(estimateRowHeightPx(200, 'artist')).toBe(272);
      expect(estimateRowHeightPx(50, 'artist')).toBe(200);   // min clamp
      expect(estimateRowHeightPx(1_000, 'artist')).toBe(520); // max clamp
    });

    it('album grows roughly linearly with cell width, clamped to its band', () => {
      expect(estimateRowHeightPx(200, 'album')).toBe(308);
      expect(estimateRowHeightPx(50, 'album')).toBe(260);    // min clamp
      expect(estimateRowHeightPx(1_000, 'album')).toBe(560);  // max clamp
    });

    it('playlist behaves like album', () => {
      expect(estimateRowHeightPx(200, 'playlist')).toBe(308);
    });

    it('offline is taller than album for the track-count footer', () => {
      expect(estimateRowHeightPx(200, 'offline')).toBe(340);
      expect(estimateRowHeightPx(200, 'album')).toBe(308);
    });
  });
});

describe('computeCardGridColumnCount', () => {
  it('never exceeds the configured max', () => {
    expect(computeCardGridColumnCount(20_000, 6)).toBe(6);
    expect(computeCardGridColumnCount(20_000, 4)).toBe(4);
  });

  it('clamps requested max to store-wide upper bound', () => {
    expect(computeCardGridColumnCount(20_000, 99)).toBe(LIBRARY_GRID_MAX_COLUMNS_MAX);
  });

  it('clamps requested max to store-wide lower bound', () => {
    expect(computeCardGridColumnCount(20_000, 2)).toBe(LIBRARY_GRID_MAX_COLUMNS_MIN);
  });

  it('returns at least one column', () => {
    expect(computeCardGridColumnCount(50, 6)).toBe(1);
  });

  it('uses six columns on wide desktop when max allows', () => {
    expect(computeCardGridColumnCount(1200, 6)).toBe(6);
  });
});
