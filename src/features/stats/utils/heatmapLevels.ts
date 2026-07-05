/** GitHub-style intensity bucket from track play count vs year max. */
export function heatmapLevel(count: number, maxCount: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0 || maxCount <= 0) return 0;
  const ratio = count / maxCount;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.5) return 3;
  if (ratio >= 0.25) return 2;
  return 1;
}

export const HEATMAP_LEVEL_COUNT = 5;

export type HeatmapCell = { date: string; count: number };

export function yearDayKeys(year: number): string[] {
  const out: string[] = [];
  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    out.push(`${y}-${m}-${day}`);
  }
  return out;
}

/** Week columns (Sun→Sat rows) with leading/trailing padding cells. */
export function heatmapWeekColumns(year: number, dayCounts: Map<string, number>): {
  weeks: HeatmapCell[][];
  maxCount: number;
} {
  const days = yearDayKeys(year);
  const maxCount = Math.max(0, ...days.map(d => dayCounts.get(d) ?? 0));
  const firstDow = new Date(year, 0, 1).getDay();
  const cells: HeatmapCell[] = [];
  for (let i = 0; i < firstDow; i++) {
    cells.push({ date: '', count: 0 });
  }
  for (const date of days) {
    cells.push({ date, count: dayCounts.get(date) ?? 0 });
  }
  while (cells.length % 7 !== 0) {
    cells.push({ date: '', count: 0 });
  }
  const weeks: HeatmapCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }
  return { weeks, maxCount };
}

/** Month labels aligned to week columns (first day of each month). */
export function heatmapMonthLabels(
  year: number,
  locale?: string,
): { columnIndex: number; label: string }[] {
  const fmt = new Intl.DateTimeFormat(locale, { month: 'short' });
  const firstDow = new Date(year, 0, 1).getDay();
  const labels: { columnIndex: number; label: string }[] = [];
  let lastMonth = -1;
  const yearStart = new Date(year, 0, 1).getTime();
  const end = new Date(year, 11, 31);
  for (let d = new Date(year, 0, 1); d <= end; d.setDate(d.getDate() + 1)) {
    const month = d.getMonth();
    if (month === lastMonth) continue;
    const dayOfYear = Math.floor((d.getTime() - yearStart) / 86_400_000);
    labels.push({
      columnIndex: Math.floor((firstDow + dayOfYear) / 7),
      label: fmt.format(new Date(year, month, 1)),
    });
    lastMonth = month;
  }
  return labels;
}

/** Weekday row labels (Sun–Sat); empty string hides a row label like GitHub. */
export function heatmapWeekdayLabels(locale?: string): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'narrow' });
  // Jan 4 2026 is Sunday — anchor week for stable weekday order.
  const anchor = new Date(2026, 0, 4);
  return Array.from({ length: 7 }, (_, i) => {
    if (i % 2 === 0) return '';
    const d = new Date(anchor);
    d.setDate(anchor.getDate() + i);
    return fmt.format(d);
  });
}

const HEATMAP_LABEL_W = 24;
const HEATMAP_BODY_GAP = 8;
const HEATMAP_CELL_MIN = 4;
const HEATMAP_CELL_MAX = 14;

/** Fit square cells to the heatmap container width (week columns only). */
export function heatmapCellMetrics(
  containerWidth: number,
  weekCount: number,
): { cell: number; gap: number; labelW: number; bodyGap: number } {
  const gap = containerWidth > 640 ? 3 : 2;
  const available = containerWidth - HEATMAP_LABEL_W - HEATMAP_BODY_GAP;
  if (available <= 0 || weekCount <= 0) {
    return { cell: HEATMAP_CELL_MIN, gap, labelW: HEATMAP_LABEL_W, bodyGap: HEATMAP_BODY_GAP };
  }
  const cell = Math.min(
    HEATMAP_CELL_MAX,
    Math.max(HEATMAP_CELL_MIN, (available - (weekCount - 1) * gap) / weekCount),
  );
  return { cell, gap, labelW: HEATMAP_LABEL_W, bodyGap: HEATMAP_BODY_GAP };
}
