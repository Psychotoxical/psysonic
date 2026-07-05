import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  HEATMAP_LEVEL_COUNT,
  heatmapCellMetrics,
  heatmapLevel,
  heatmapMonthLabels,
  heatmapWeekColumns,
  heatmapWeekdayLabels,
  type HeatmapCell,
} from '@/features/stats/utils/heatmapLevels';

const LEVEL_OPACITY = [0.14, 0.32, 0.52, 0.72, 1] as const;

type Props = {
  year: number;
  dayCounts: Map<string, number>;
  selectedDate: string | null;
  onSelectDate: (date: string) => void;
};

function cellClass(cell: HeatmapCell, level: number, active: boolean): string {
  const parts = ['player-heatmap-cell'];
  if (!cell.date) parts.push('player-heatmap-cell--pad');
  else if (cell.count <= 0) parts.push('player-heatmap-cell--empty');
  else parts.push(`player-heatmap-cell--l${level}`);
  if (active) parts.push('player-heatmap-cell--selected');
  return parts.join(' ');
}

function cellStyle(cell: HeatmapCell, level: number): CSSProperties | undefined {
  if (!cell.date || cell.count <= 0) return undefined;
  return {
    background: `color-mix(in srgb, var(--accent) ${Math.round(LEVEL_OPACITY[level] * 100)}%, transparent)`,
  };
}

export default function PlayerStatsHeatmap({ year, dayCounts, selectedDate, onSelectDate }: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [layoutWidth, setLayoutWidth] = useState(0);

  const { weeks, maxCount } = useMemo(
    () => heatmapWeekColumns(year, dayCounts),
    [year, dayCounts],
  );
  const monthLabels = useMemo(() => heatmapMonthLabels(year, locale), [year, locale]);
  const weekdayLabels = useMemo(() => heatmapWeekdayLabels(locale), [locale]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setLayoutWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [weeks.length]);

  const { cell, gap, labelW, bodyGap } = useMemo(
    () => heatmapCellMetrics(layoutWidth, weeks.length),
    [layoutWidth, weeks.length],
  );

  const heatmapVars = {
    '--hm-weeks': weeks.length,
    '--hm-cell': `${cell}px`,
    '--hm-gap': `${gap}px`,
    '--hm-label-w': `${labelW}px`,
    '--hm-body-gap': `${bodyGap}px`,
    '--hm-pitch': `${cell + gap}px`,
    '--hm-grid-w': `${weeks.length * (cell + gap) - gap}px`,
  } as CSSProperties;

  return (
    <div ref={wrapRef} className="player-heatmap-wrap">
      <div className="player-heatmap" style={heatmapVars}>
        <div className="player-heatmap-months" aria-hidden="true">
          {monthLabels.map(m => (
            <span
              key={`${m.columnIndex}-${m.label}`}
              className="player-heatmap-month"
              style={{ '--column-index': m.columnIndex } as CSSProperties}
            >
              {m.label}
            </span>
          ))}
        </div>

        <div className="player-heatmap-body">
          <div className="player-heatmap-weekdays" aria-hidden="true">
            {weekdayLabels.map((label, i) => (
              <span key={i}>{label}</span>
            ))}
          </div>

          <div className="player-heatmap-columns">
            {weeks.map((week, wi) => (
              <div key={wi} className="player-heatmap-col">
                {week.map((cellItem, di) => {
                  if (!cellItem.date) {
                    return <span key={di} className="player-heatmap-cell player-heatmap-cell--pad" />;
                  }
                  const level = heatmapLevel(cellItem.count, maxCount);
                  const active = selectedDate === cellItem.date;
                  return (
                    <button
                      key={cellItem.date}
                      type="button"
                      className={cellClass(cellItem, level, active)}
                      style={cellStyle(cellItem, level)}
                      title={`${cellItem.date}: ${t('statistics.playerDayTrackPlays', { count: cellItem.count })}`}
                      aria-label={`${cellItem.date}: ${t('statistics.playerDayTrackPlays', { count: cellItem.count })}`}
                      aria-pressed={active}
                      onClick={() => onSelectDate(cellItem.date)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <div className="player-heatmap-legend" aria-hidden="true">
          <span>{t('statistics.playerHeatmapLess')}</span>
          {Array.from({ length: HEATMAP_LEVEL_COUNT }, (_, level) => (
            <span
              key={level}
              className={`player-heatmap-cell player-heatmap-cell--sample${level === 0 ? ' player-heatmap-cell--empty' : ''}`}
              style={level === 0 ? undefined : {
                background: `color-mix(in srgb, var(--accent) ${Math.round(LEVEL_OPACITY[level as 0 | 1 | 2 | 3 | 4] * 100)}%, transparent)`,
              }}
            />
          ))}
          <span>{t('statistics.playerHeatmapMore')}</span>
        </div>
      </div>
    </div>
  );
}
