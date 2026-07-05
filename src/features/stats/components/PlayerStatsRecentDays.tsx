import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  libraryGetPlayerStatsDayDetail,
  libraryGetPlayerStatsRecentDays,
  type PlaySessionDayDetail,
  type PlaySessionRecentDay,
} from '@/lib/api/library';
import { formatPlayerStatsListeningTotal } from '@/lib/format/formatHumanDuration';
import {
  formatPlayerStatsDayLabel,
  PLAYER_STATS_RECENT_DAYS_LIMIT,
} from '@/features/stats/utils/formatPlayerStatsDay';
import PlayerStatsDayTracks from '@/features/stats/components/PlayerStatsDayTracks';

type Props = {
  /** Day selected on the heatmap — auto-expand when present. */
  heatmapSelectedDate: string | null;
  /** Full reload (year change) — shows section spinner. */
  refreshKey: number;
  /** Silent poll while listening — updates list and expanded day details. */
  liveRefreshKey: number;
};

function formatDayMeta(
  summary: PlaySessionRecentDay,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  return [
    formatPlayerStatsListeningTotal(summary.totalListenedSec),
    t('statistics.playerDaySessions', { count: summary.sessionCount }),
    t('statistics.playerDayTrackPlays', { count: summary.trackPlayCount }),
  ].join(' · ');
}

export default function PlayerStatsRecentDays({
  heatmapSelectedDate,
  refreshKey,
  liveRefreshKey,
}: Props) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const [days, setDays] = useState<PlaySessionRecentDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedDates, setExpandedDates] = useState<Set<string>>(() => new Set());
  const [details, setDetails] = useState<Map<string, PlaySessionDayDetail>>(() => new Map());
  const [loadingDates, setLoadingDates] = useState<Set<string>>(() => new Set());
  const detailsRef = useRef(details);
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  detailsRef.current = details;
  const expandedRef = useRef(expandedDates);
  // React Compiler refs rule: ref kept in sync with the latest value for use in effects/handlers/cleanup; not render data.
  // eslint-disable-next-line react-hooks/refs
  expandedRef.current = expandedDates;

  const loadDetail = useCallback(async (date: string) => {
    setLoadingDates(prev => new Set(prev).add(date));
    try {
      const detail = await libraryGetPlayerStatsDayDetail(date);
      setDetails(prev => new Map(prev).set(date, detail));
    } catch {
      /* ignore */
    } finally {
      setLoadingDates(prev => {
        const next = new Set(prev);
        next.delete(date);
        return next;
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    libraryGetPlayerStatsRecentDays(PLAYER_STATS_RECENT_DAYS_LIMIT)
      .then(rows => {
        if (!cancelled) {
          setDays(rows);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDays([]);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [refreshKey]);

  useEffect(() => {
    if (liveRefreshKey === 0) return;
    let cancelled = false;
    libraryGetPlayerStatsRecentDays(PLAYER_STATS_RECENT_DAYS_LIMIT)
      .then(rows => {
        if (cancelled) return;
        setDays(rows);
        const refreshDates = new Set(expandedRef.current);
        if (heatmapSelectedDate && expandedRef.current.has(heatmapSelectedDate)) {
          refreshDates.add(heatmapSelectedDate);
        }
        setDetails(prev => {
          const next = new Map(prev);
          for (const date of refreshDates) next.delete(date);
          return next;
        });
        for (const date of refreshDates) {
          void loadDetail(date);
        }
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [liveRefreshKey, heatmapSelectedDate, loadDetail]);

  const daySet = useMemo(() => new Set(days.map(d => d.date)), [days]);

  const ensureDetail = useCallback(async (date: string) => {
    if (detailsRef.current.has(date)) return;
    await loadDetail(date);
  }, [loadDetail]);

  const toggleDate = useCallback((date: string) => {
    setExpandedDates(prev => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
    void ensureDetail(date);
  }, [ensureDetail]);

  useEffect(() => {
    if (!heatmapSelectedDate) return;
    // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpandedDates(prev => new Set(prev).add(heatmapSelectedDate));
    void ensureDetail(heatmapSelectedDate);
  }, [heatmapSelectedDate, ensureDetail]);

  const extraHeatmapDay = heatmapSelectedDate && !daySet.has(heatmapSelectedDate)
    ? heatmapSelectedDate
    : null;

  if (loading) {
    return (
      <section className="player-stats-recent">
        <h2 className="section-title">{t('statistics.playerRecentDaysTitle')}</h2>
        <div className="loading-center" style={{ minHeight: '4rem' }}>
          <div className="spinner" />
        </div>
      </section>
    );
  }

  if (days.length === 0 && !extraHeatmapDay) return null;

  const renderRow = (date: string, summary: PlaySessionRecentDay | null) => {
    const open = expandedDates.has(date);
    const detail = details.get(date);
    const pending = loadingDates.has(date);
    const label = formatPlayerStatsDayLabel(date, t, locale);
    const meta = summary ? formatDayMeta(summary, t) : null;

    return (
      <div key={date} className={`player-stats-day-item${open ? ' player-stats-day-item--open' : ''}`}>
        <button
          type="button"
          className="player-stats-day-header"
          onClick={() => toggleDate(date)}
          aria-expanded={open}
        >
          <span className="player-stats-day-header-text">
            <span className="player-stats-day-label">{label}</span>
            {meta && <span className="player-stats-day-summary">{meta}</span>}
          </span>
          <ChevronDown size={16} className="player-stats-day-chevron" aria-hidden />
        </button>
        {open && (
          <div className="player-stats-day-body">
            {pending && !detail && (
              <div className="loading-center" style={{ minHeight: '2.5rem' }}>
                <div className="spinner" style={{ width: 16, height: 16 }} />
              </div>
            )}
            {detail && <PlayerStatsDayTracks detail={detail} />}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="player-stats-recent">
      <h2 className="section-title">{t('statistics.playerRecentDaysTitle')}</h2>
      <div className="player-stats-day-list">
        {extraHeatmapDay && renderRow(extraHeatmapDay, null)}
        {days.map(day => renderRow(day.date, day))}
      </div>
    </section>
  );
}
