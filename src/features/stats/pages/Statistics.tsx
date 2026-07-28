import { fetchStatisticsLibraryAggregates, fetchStatisticsOverview } from '@/lib/api/subsonicStatistics';
import type { SubsonicAlbum, SubsonicGenre } from '@/lib/api/subsonicTypes';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Share2 } from 'lucide-react';
import { formatHumanHoursMinutes } from '@/lib/format/formatHumanDuration';
import { AlbumRow } from '@/features/album';
import StatsExportModal from '@/features/stats/components/StatsExportModal';
import PlayerStatisticsPanel from '@/features/stats/components/PlayerStatisticsPanel';
import StatisticsTabBar from '@/features/stats/components/StatisticsTabBar';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { useLocation } from 'react-router';
import { getMusicNetworkRuntime, type RecentTrack, type StatsPeriod, type TopItem } from '@/music-network';
import { useEnrichmentPrimaryLabel } from '@/music-network/ui';
import { useOfflineBrowseContext } from '@/features/offline';
import { usePlayerStatsRecordingEnabled } from '@/features/stats/hooks/usePlayerStatsRecordingEnabled';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function relativeTime(timestamp: number, t: (key: string, opts?: any) => string): string {
  const diff = Math.floor(Date.now() / 1000) - timestamp;
  if (diff < 60) return t('statistics.lfmJustNow');
  if (diff < 3600) return t('statistics.lfmMinutesAgo', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('statistics.lfmHoursAgo', { n: Math.floor(diff / 3600) });
  return t('statistics.lfmDaysAgo', { n: Math.floor(diff / 86400) });
}

const PERIODS: { key: StatsPeriod; label: string }[] = [
  { key: '7day', label: 'lfmPeriod7day' },
  { key: '1month', label: 'lfmPeriod1month' },
  { key: '3month', label: 'lfmPeriod3month' },
  { key: '6month', label: 'lfmPeriod6month' },
  { key: '12month', label: 'lfmPeriod12month' },
  { key: 'overall', label: 'lfmPeriodOverall' },
];

function StatisticsLoadingDots({ label }: { label: string }) {
  return (
    <span className="statistics-loading-dots" aria-label={label} role="status">
      <span />
      <span />
      <span />
    </span>
  );
}

export default function Statistics() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const isPlayerStats = location.pathname === '/player-stats';
  const offlineBrowseActive = useOfflineBrowseContext().active;
  const playerStatsEnabled = usePlayerStatsRecordingEnabled();
  const enrichmentPrimaryId = useAuthStore(s => s.enrichmentPrimaryId);
  const enrichmentLabel = useEnrichmentPrimaryLabel() ?? '';
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const libraryBrowseScopeVersion = useAuthStore(s => s.libraryBrowseScopeVersion);
  const [recent, setRecent] = useState<SubsonicAlbum[]>([]);
  const [frequent, setFrequent] = useState<SubsonicAlbum[]>([]);
  const [highest, setHighest] = useState<SubsonicAlbum[]>([]);
  const [artistCount, setArtistCount] = useState<number | null>(null);
  const [totalSongs, setTotalSongs] = useState<number | null>(null);
  const [totalAlbums, setTotalAlbums] = useState<number | null>(null);
  const [genres, setGenres] = useState<SubsonicGenre[]>([]);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [aggregateLoading, setAggregateLoading] = useState(true);
  const [aggregateUnavailable, setAggregateUnavailable] = useState(false);

  const [totalPlaytime, setTotalPlaytime] = useState<number | null>(null);
  const [playtimeCapped, setPlaytimeCapped] = useState(false);
  const [formatData, setFormatData] = useState<{ format: string; count: number }[] | null>(null);
  const [formatTrackCount, setFormatTrackCount] = useState(0);

  const [exportOpen, setExportOpen] = useState(false);

  // Enrichment-primary listening stats. The `lfm*` local names and the
  // `statistics.lfm*` i18n keys are the original (pre-framework) identifiers,
  // kept as-is: the user-facing copy is provider-neutral ({{provider}}), and the
  // keys share the `lfmPeriod`/`lfmPeriod7day` prefix so a blanket rename is
  // unsafe. Internal-only; not a framework-boundary concern.
  const [lfmPeriod, setLfmPeriod] = useState<StatsPeriod>('1month');
  const [lfmTopArtists, setLfmTopArtists] = useState<TopItem[]>([]);
  const [lfmTopAlbums, setLfmTopAlbums] = useState<TopItem[]>([]);
  const [lfmTopTracks, setLfmTopTracks] = useState<TopItem[]>([]);
  const [lfmLoading, setLfmLoading] = useState(false);
  const [lfmRecentTracks, setLfmRecentTracks] = useState<RecentTrack[]>([]);
  const [lfmRecentLoading, setLfmRecentLoading] = useState(false);

  useEffect(() => {
    if (offlineBrowseActive && playerStatsEnabled && !isPlayerStats) {
      navigate('/player-stats', { replace: true });
    }
  }, [offlineBrowseActive, playerStatsEnabled, isPlayerStats, navigate]);

  useEffect(() => {
    if (offlineBrowseActive || isPlayerStats) {
      // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOverviewLoading(false);
      return;
    }
    setOverviewLoading(true);
    fetchStatisticsOverview()
      .then(d => {
        setRecent(d.recent);
        setFrequent(d.frequent);
        setHighest(d.highest);
        setOverviewLoading(false);
      })
      .catch(() => setOverviewLoading(false));
  }, [musicLibraryFilterVersion, libraryBrowseScopeVersion, offlineBrowseActive, isPlayerStats]);

  // Background: playtime, album/song counts, genre insights (cached per server+library like rating prefetch)
  useEffect(() => {
    if (offlineBrowseActive || isPlayerStats) return;
    let cancelled = false;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setArtistCount(null);
    setTotalPlaytime(null);
    setTotalAlbums(null);
    setTotalSongs(null);
    setPlaytimeCapped(false);
    setGenres([]);
    setFormatData(null);
    setFormatTrackCount(0);
    setAggregateLoading(true);
    setAggregateUnavailable(false);
    (async () => {
      try {
        const agg = await fetchStatisticsLibraryAggregates();
        if (cancelled) return;
        setArtistCount(agg.artistCount);
        setTotalPlaytime(agg.playtimeSec);
        setTotalAlbums(agg.albumsCounted);
        setTotalSongs(agg.songsCounted);
        setPlaytimeCapped(agg.capped);
        setGenres(agg.genres);
        setFormatData(agg.formats);
        setFormatTrackCount(agg.formatTrackCount ?? agg.songsCounted);
        setAggregateLoading(false);
        setAggregateUnavailable(false);
      } catch {
        if (!cancelled) {
          setArtistCount(null);
          setTotalPlaytime(null);
          setTotalAlbums(null);
          setTotalSongs(null);
          setPlaytimeCapped(false);
          setGenres([]);
          setFormatData([]);
          setFormatTrackCount(0);
          setAggregateLoading(false);
          setAggregateUnavailable(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [musicLibraryFilterVersion, libraryBrowseScopeVersion, offlineBrowseActive, isPlayerStats]);

  useEffect(() => {
    if (offlineBrowseActive || isPlayerStats) return;
    if (enrichmentPrimaryId === null) return;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLfmRecentLoading(true);
    getMusicNetworkRuntime().getRecentTracks(20)
      .then(tracks => { setLfmRecentTracks(tracks); setLfmRecentLoading(false); })
      .catch(() => setLfmRecentLoading(false));
  }, [enrichmentPrimaryId, offlineBrowseActive, isPlayerStats]);

  useEffect(() => {
    if (offlineBrowseActive || isPlayerStats) return;
    if (enrichmentPrimaryId === null) return;
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLfmLoading(true);
    Promise.all([
      getMusicNetworkRuntime().getTopItems(lfmPeriod, 'artists', 10),
      getMusicNetworkRuntime().getTopItems(lfmPeriod, 'albums', 10),
      getMusicNetworkRuntime().getTopItems(lfmPeriod, 'tracks', 10),
    ]).then(([artists, albums, tracks]) => {
      setLfmTopArtists(artists);
      setLfmTopAlbums(albums);
      setLfmTopTracks(tracks);
      setLfmLoading(false);
    }).catch(() => setLfmLoading(false));
  }, [lfmPeriod, enrichmentPrimaryId, offlineBrowseActive, isPlayerStats]);

  const playtimeDisplay = aggregateUnavailable
    ? '—'
    : totalPlaytime === null
    ? t('statistics.computing')
    : (playtimeCapped ? '≥ ' : '') + formatHumanHoursMinutes(totalPlaytime);

  const countDisplay = (n: number | null) =>
    aggregateUnavailable
      ? '—'
      : n === null ? t('statistics.computing') : (playtimeCapped ? '≥ ' : '') + n.toLocaleString();

  const stats = [
    { label: t('statistics.statArtists'), value: aggregateUnavailable ? '—' : artistCount?.toLocaleString() ?? t('statistics.computing'), tooltip: t('statistics.statArtistsTooltip') },
    { label: t('statistics.statAlbums'), value: countDisplay(totalAlbums) },
    { label: t('statistics.statSongs'), value: countDisplay(totalSongs) },
    { label: t('statistics.statPlaytime'), value: playtimeDisplay },
  ];

  const topGenres = genres.slice(0, 10);
  const maxGenreSongs = topGenres[0]?.songCount ?? 1;

  return (
    <div className="content-body animate-fade-in">
      <h1 className="page-title">{t('statistics.title')}</h1>
      <StatisticsTabBar />

      {isPlayerStats ? (
        <PlayerStatisticsPanel />
      ) : (
        <div className="stats-page">

          <div className="stats-overview">
            {stats.map(s => (
              <div key={s.label} className="stats-card">
                <span className="stats-card-value">{aggregateLoading ? <StatisticsLoadingDots label={t('statistics.computing')} /> : s.value}</span>
                <span className="stats-card-label" data-tooltip={s.tooltip} data-tooltip-wrap="true">{s.label}</span>
              </div>
            ))}
          </div>

          {/* Genre Insights + Format Distribution */}
          {(topGenres.length > 0 || formatData || aggregateLoading) && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem', marginBottom: '0.5rem' }}>

              {(topGenres.length > 0 || aggregateLoading) && (
                <div style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: '12px', padding: '1.25rem', backdropFilter: 'blur(8px)' }}>
                  <h3 style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--accent)', marginBottom: '1rem' }}>
                    {t('statistics.genreInsights')}
                  </h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                    {aggregateLoading ? <StatisticsLoadingDots label={t('statistics.computing')} /> : topGenres.map(g => (
                      <div key={g.value || '__genre_unknown__'}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.2rem' }}>
                          <span style={{ fontSize: '0.8rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '70%' }}>
                            {g.value.trim() ? g.value : t('statistics.decadeUnknown')}
                          </span>
                          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', flexShrink: 0, marginLeft: '0.5rem' }}>
                            {g.songCount.toLocaleString()}
                          </span>
                        </div>
                        <div style={{ height: '4px', borderRadius: '2px', background: 'var(--glass-border)', overflow: 'hidden' }}>
                          <div style={{
                            height: '100%',
                            width: `${(g.songCount / maxGenreSongs) * 100}%`,
                            background: 'var(--accent)',
                            opacity: 0.7,
                            borderRadius: '2px',
                            transition: 'width 0.4s ease',
                          }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(formatData || aggregateLoading) && (
                <div style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: '12px', padding: '1.25rem', backdropFilter: 'blur(8px)' }}>
                  <h3 style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--accent)', marginBottom: '0.25rem' }}>
                    {t('statistics.formatDistribution')}
                  </h3>
                  <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                    {aggregateLoading ? <StatisticsLoadingDots label={t('statistics.computing')} /> : t('statistics.formatSample', { n: formatTrackCount.toLocaleString() })}
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                    {!aggregateLoading && formatData?.map(f => {
                      const pct = formatTrackCount > 0 ? Math.round((f.count / formatTrackCount) * 100) : 0;
                      return (
                        <div key={f.format}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.2rem' }}>
                            <span style={{ fontSize: '0.8rem', fontWeight: 600, fontFamily: 'monospace' }}>{f.format}</span>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{pct}%</span>
                          </div>
                          <div style={{ height: '4px', borderRadius: '2px', background: 'var(--glass-border)', overflow: 'hidden' }}>
                            <div style={{
                              height: '100%',
                              width: `${pct}%`,
                              background: 'var(--accent)',
                              opacity: 0.6,
                              borderRadius: '2px',
                              transition: 'width 0.4s ease',
                            }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

            </div>
          )}

          {overviewLoading ? <div className="statistics-row-loading"><StatisticsLoadingDots label={t('statistics.computing')} /></div> : recent.length > 0 && (
            <AlbumRow title={t('statistics.recentlyPlayed')} albums={recent} />
          )}

          {overviewLoading ? <div className="statistics-row-loading"><StatisticsLoadingDots label={t('statistics.computing')} /></div> : <AlbumRow
            title={t('statistics.mostPlayed')}
            albums={frequent}
            headerExtra={frequent.length >= 9 ? (
              <button
                type="button"
                className="nav-btn"
                onClick={() => setExportOpen(true)}
                data-tooltip={t('statistics.exportTitle')}
                aria-label={t('statistics.exportTitle')}
              >
                <Share2 size={18} />
              </button>
            ) : undefined}
          />}

          {overviewLoading ? <div className="statistics-row-loading"><StatisticsLoadingDots label={t('statistics.computing')} /></div> : <AlbumRow
            title={t('statistics.highestRated')}
            albums={highest}
            showRating
          />}

          {/* Music Network Stats */}
          {enrichmentPrimaryId !== null && (
            <section style={{ marginTop: '2rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
                <h2 className="section-title" style={{ margin: 0 }}>{t('statistics.lfmTitle', { provider: enrichmentLabel })}</h2>
                <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap' }}>
                  {PERIODS.map(p => (
                    <button
                      key={p.key}
                      className={`btn btn-sm ${lfmPeriod === p.key ? 'btn-primary' : 'btn-surface'}`}
                      onClick={() => setLfmPeriod(p.key)}
                      style={{ padding: '0.25rem 0.625rem', fontSize: '0.75rem' }}
                    >
                      {t(`statistics.${p.label}`)}
                    </button>
                  ))}
                </div>
              </div>

              {lfmLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--text-muted)', fontSize: '0.875rem', padding: '1rem 0' }}>
                  <div className="spinner" style={{ width: 16, height: 16, borderTopColor: 'currentColor' }} />
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1rem' }}>
                  {([
                    { label: t('statistics.lfmTopArtists'), items: lfmTopArtists.map(a => ({ primary: a.name, secondary: null, playcount: a.playcount })) },
                    { label: t('statistics.lfmTopAlbums'),  items: lfmTopAlbums.map(a =>  ({ primary: a.name, secondary: a.artist ?? null, playcount: a.playcount })) },
                    { label: t('statistics.lfmTopTracks'),  items: lfmTopTracks.map(tr => ({ primary: tr.name, secondary: tr.artist ?? null, playcount: tr.playcount })) },
                  ] as { label: string; items: { primary: string; secondary: string | null; playcount: string }[] }[]).map(col => {
                    const max = Math.max(...col.items.map(it => Number(it.playcount)), 1);
                    return (
                      <div key={col.label} style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: '12px', padding: '1.25rem', backdropFilter: 'blur(8px)' }}>
                        <h3 style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--accent)', marginBottom: '1rem' }}>
                          {col.label}
                        </h3>
                        <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
                          {col.items.map((it, i) => (
                            <li key={`${it.primary}-${i}`}>
                              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.625rem', marginBottom: '0.25rem' }}>
                                <span style={{ fontSize: '1.1rem', fontWeight: 800, color: i === 0 ? 'var(--accent)' : 'var(--text-muted)', opacity: i === 0 ? 1 : 0.5, lineHeight: 1, flexShrink: 0, width: '1.5rem' }}>
                                  {i + 1}
                                </span>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: '0.875rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.primary}</div>
                                  {it.secondary && (
                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.secondary}</div>
                                  )}
                                </div>
                                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', flexShrink: 0 }}>{Number(it.playcount).toLocaleString()}</span>
                              </div>
                              <div style={{ height: '2px', borderRadius: '1px', background: 'var(--glass-border)', overflow: 'hidden', marginLeft: '2.125rem' }}>
                                <div style={{ height: '100%', width: `${(Number(it.playcount) / max) * 100}%`, background: i === 0 ? 'var(--accent)' : 'var(--text-muted)', opacity: i === 0 ? 0.8 : 0.3, borderRadius: '1px', transition: 'width 0.4s ease' }} />
                              </div>
                            </li>
                          ))}
                        </ol>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* Recent Scrobbles */}
          {enrichmentPrimaryId !== null && (
            <section style={{ marginTop: '2rem' }}>
              <h2 className="section-title" style={{ marginBottom: '1rem' }}>{t('statistics.lfmRecentTracks')}</h2>
              {lfmRecentLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                  <div className="spinner" style={{ width: 16, height: 16, borderTopColor: 'currentColor' }} />
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                  {lfmRecentTracks.slice(0, 3).map((track, i) => (
                    <div key={`${track.name}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.5rem 0.75rem', borderRadius: '8px', background: track.nowPlaying ? 'color-mix(in srgb, var(--accent) 8%, transparent)' : 'transparent', border: track.nowPlaying ? '1px solid color-mix(in srgb, var(--accent) 20%, transparent)' : '1px solid transparent' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontSize: '0.875rem', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{track.name}</span>
                          {track.nowPlaying && (
                            <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: 'var(--accent)', color: 'var(--bg-app)', opacity: 0.85, letterSpacing: '0.04em', textTransform: 'uppercase', flexShrink: 0 }}>{t('statistics.lfmNowPlaying')}</span>
                          )}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {track.artist}{track.album ? ` · ${track.album}` : ''}
                        </div>
                      </div>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                        {track.nowPlaying ? '' : track.timestamp ? relativeTime(track.timestamp, t) : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

        </div>
      )}
      {!isPlayerStats && (
      <StatsExportModal
        open={exportOpen}
        albums={frequent}
        onClose={() => setExportOpen(false)}
      />
      )}
    </div>
  );
}
