import { describe, expect, it } from 'vitest';
import { heatmapCellMetrics } from '@/features/stats/utils/heatmapLevels';

describe('heatmapCellMetrics', () => {
  it('shrinks cells to fit narrow containers', () => {
    const m = heatmapCellMetrics(400, 53);
    expect(m.cell).toBeLessThan(14);
    expect(m.cell).toBeGreaterThanOrEqual(4);
    const total = m.labelW + m.bodyGap + 53 * m.cell + 52 * m.gap;
    expect(total).toBeLessThanOrEqual(400 + 1);
  });

  it('caps at 14px on wide containers', () => {
    const m = heatmapCellMetrics(1200, 53);
    expect(m.cell).toBe(14);
  });
});
