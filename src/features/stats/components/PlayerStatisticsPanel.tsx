import React, { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Share2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  libraryGetPlayerStatsHeatmap,
  libraryGetPlayerStatsYearBounds,
  libraryGetPlayerStatsYearSummary,
  type PlaySessionYearBounds,
  type PlaySessionYearSummary,
} from '@/lib/api/library';
import { usePlayerStatsLiveRefresh } from '@/features/stats/hooks/usePlayerStatsLiveRefresh';
import { usePlayerStatsRecordingEnabled } from '@/features/stats/hooks/usePlayerStatsRecordingEnabled';
import { useYearRecapData } from '@/features/stats/hooks/useYearRecapData';
import PlayerStatsHeatmap from '@/features/stats/components/PlayerStatsHeatmap';
import PlayerStatsIndexRequiredNotice from '@/features/stats/components/PlayerStatsIndexRequiredNotice';
import PlayerStatsRecentDays from '@/features/stats/components/PlayerStatsRecentDays';
import YearRecapStory from '@/features/stats/components/YearRecapStory';
import YearRecapExportModal from '@/features/stats/components/YearRecapExportModal';
import { formatPlayerStatsListeningTotal } from '@/lib/format/formatHumanDuration';

const currentCalendarYear = () => new Date().getFullYear();

export default function PlayerStatisticsPanel() {
  const { t } = useTranslation();
  const recordingEnabled = usePlayerStatsRecordingEnabled();
  const [year, setYear] = useState(currentCalendarYear);
  const [yearBounds, setYearBounds] = useState<PlaySessionYearBounds | null>(null);
  const [summary, setSummary] = useState<PlaySessionYearSummary | null>(null);
  const [dayCounts, setDayCounts] = useState<Map<string, number>>(new Map());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [recentRefreshKey, setRecentRefreshKey] = useState(0);
  const [liveRefreshKey, setLiveRefreshKey] = useState(0);
  const [recapRequestId, setRecapRequestId] = useState(0);
  const [recapStoryOpen, setRecapStoryOpen] = useState(false);
  const [recapExportOpen, setRecapExportOpen] = useState(false);
  const recapData = useYearRecapData(year, recapRequestId);

  useEffect(() => {
    if (!recordingEnabled) {
      // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      setSummary(null);
      setDayCounts(new Map());
      setSelectedDate(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setSelectedDate(null);
    Promise.all([
      libraryGetPlayerStatsYearSummary(year),
      libraryGetPlayerStatsHeatmap(year),
      libraryGetPlayerStatsYearBounds(),
    ])
      .then(([s, heat, bounds]) => {
        if (cancelled) return;
        setSummary(s);
        setDayCounts(new Map(heat.map(h => [h.date, h.trackPlayCount])));
        setYearBounds(bounds);
        setLoading(false);
        setRecentRefreshKey(k => k + 1);
      })
      .catch(() => {
        if (!cancelled) {
          setSummary(null);
          setDayCounts(new Map());
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [year, recordingEnabled]);

  const refreshLive = useCallback(async () => {
    if (!recordingEnabled) return;
    try {
      const [s, heat] = await Promise.all([
        libraryGetPlayerStatsYearSummary(year),
        libraryGetPlayerStatsHeatmap(year),
      ]);
      setSummary(s);
      setDayCounts(new Map(heat.map(h => [h.date, h.trackPlayCount])));
      setLiveRefreshKey(k => k + 1);
    } catch {
      /* ignore transient read errors during live refresh */
    }
  }, [year, recordingEnabled]);

  usePlayerStatsLiveRefresh(refreshLive);

  const [recapPending, setRecapPending] = useState<null | 'story' | 'export'>(null);
  useEffect(() => {
    if (!recapPending) return;
    if (recapData.error) {
      // React Compiler set-state-in-effect rule: transient open-intent resolved from async load state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRecapPending(null);
      return;
    }
    if (!recapData.data) return;
    if (recapPending === 'story') setRecapStoryOpen(true);
    else setRecapExportOpen(true);
    setRecapPending(null);
  }, [recapPending, recapData.data, recapData.error]);

  const openRecap = (target: 'story' | 'export') => {
    setRecapRequestId(id => id + 1);
    setRecapPending(target);
  };

  if (!recordingEnabled) {
    return (
      <div className="stats-page">
        <PlayerStatsIndexRequiredNotice />
      </div>
    );
  }

  const empty = !loading && (summary?.trackPlayCount ?? 0) === 0;
  const calYear = currentCalendarYear();
  const maxNavYear = yearBounds?.maxYear != null
    ? Math.min(calYear, yearBounds.maxYear)
    : calYear;
  const canGoPrev = !loading && yearBounds?.minYear != null && year > yearBounds.minYear;
  const canGoNext = !loading && year < maxNavYear;

  return (
    <div className="stats-page">
      <div className="player-stats-year-nav">
        <button
          type="button"
          className="btn btn-surface btn-sm"
          onClick={() => canGoPrev && setYear(y => y - 1)}
          disabled={!canGoPrev}
          aria-label={t('statistics.playerYearPrev')}
          aria-disabled={!canGoPrev}
        >
          <ChevronLeft size={16} />
        </button>
        <span style={{ fontWeight: 700, fontSize: '1.1rem' }}>{year}</span>
        <button
          type="button"
          className="btn btn-surface btn-sm"
          onClick={() => canGoNext && setYear(y => y + 1)}
          disabled={!canGoNext}
          aria-label={t('statistics.playerYearNext')}
          aria-disabled={!canGoNext}
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {loading ? (
        <div className="loading-center"><div className="spinner" /></div>
      ) : (
        <>
          {!empty && summary && (
            <div className="stats-overview" style={{ marginBottom: '1.25rem' }}>
              <div className="stats-card">
                <span className="stats-card-value">{formatPlayerStatsListeningTotal(summary.totalListenedSec)}</span>
                <span className="stats-card-label">{t('statistics.playerSummaryTime')}</span>
              </div>
              <div className="stats-card">
                <span className="stats-card-value">{summary.sessionCount.toLocaleString()}</span>
                <span className="stats-card-label">{t('statistics.playerSummarySessions')}</span>
              </div>
              <div className="stats-card">
                <span className="stats-card-value">{summary.trackPlayCount.toLocaleString()}</span>
                <span className="stats-card-label">{t('statistics.playerSummaryTracks')}</span>
              </div>
              <div className="stats-card">
                <span className="stats-card-value">{summary.uniqueTrackCount.toLocaleString()}</span>
                <span className="stats-card-label">{t('statistics.playerSummaryUniqueTracks')}</span>
              </div>
              <div className="stats-card">
                <span className="stats-card-value">{summary.listeningDayCount.toLocaleString()}</span>
                <span className="stats-card-label">{t('statistics.playerSummaryDays')}</span>
              </div>
              <div className="stats-card">
                <span className="stats-card-value">{summary.fullCount} / {summary.partialCount}</span>
                <span className="stats-card-label">{t('statistics.playerSummaryCompletion')}</span>
              </div>
            </div>
          )}

          {empty && (
            <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>{t('statistics.playerEmpty')}</p>
          )}

          {!empty && (
            <div className="year-recap-card">
              <div className="year-recap-card-text">
                <span className="year-recap-card-kicker">{t('statistics.recapIntroKicker')}</span>
                <span className="year-recap-card-title">{t('statistics.recapCardTitle', { year })}</span>
              </div>
              <div className="year-recap-card-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => openRecap('story')}
                  disabled={recapData.loading && recapPending === 'story'}
                >
                  <Sparkles size={16} />
                  {recapData.loading && recapPending === 'story'
                    ? t('statistics.computing')
                    : t('statistics.recapCardCta')}
                </button>
                <button
                  type="button"
                  className="btn btn-surface"
                  onClick={() => openRecap('export')}
                  disabled={recapData.loading && recapPending === 'export'}
                  aria-label={t('statistics.recapShareCta')}
                  data-tooltip={t('statistics.recapShareCta')}
                >
                  <Share2 size={16} />
                </button>
              </div>
            </div>
          )}

          <PlayerStatsHeatmap
            year={year}
            dayCounts={dayCounts}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
          />
        </>
      )}

      {!loading && (
        <PlayerStatsRecentDays
          heatmapSelectedDate={selectedDate}
          refreshKey={recentRefreshKey}
          liveRefreshKey={liveRefreshKey}
        />
      )}

      {recapStoryOpen && recapData.data && (
        <YearRecapStory
          data={recapData.data}
          onClose={() => setRecapStoryOpen(false)}
          onShare={() => setRecapExportOpen(true)}
        />
      )}
      {recapData.data && (
        <YearRecapExportModal
          open={recapExportOpen}
          data={recapData.data}
          onClose={() => setRecapExportOpen(false)}
        />
      )}
    </div>
  );
}
