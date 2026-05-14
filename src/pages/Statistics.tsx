import { fetchStatisticsFormatSample, fetchStatisticsLibraryAggregates, fetchStatisticsOverview } from '../api/subsonicStatistics';
import { getAlbumList } from '../api/subsonicLibrary';
import type { SubsonicAlbum, SubsonicGenre } from '../api/subsonicTypes';
import React, { useEffect, useState } from 'react';
import { Share2 } from 'lucide-react';
import { formatHumanHoursMinutes } from '../utils/format/formatHumanDuration';
import AlbumRow from '../components/AlbumRow';
import StatsExportModal from '../components/StatsExportModal';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';
import { useNavigate } from 'react-router-dom';
import { lastfmIsConfigured, lastfmGetTopArtists, lastfmGetTopAlbums, lastfmGetTopTracks, lastfmGetRecentTracks, LastfmPeriod, LastfmTopArtist, LastfmTopAlbum, LastfmTopTrack, LastfmRecentTrack } from '../api/lastfm';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function relativeTime(timestamp: number, t: (key: string, opts?: any) => string): string {
  const diff = Math.floor(Date.now() / 1000) - timestamp;
  if (diff < 60) return t('statistics.lfmJustNow');
  if (diff < 3600) return t('statistics.lfmMinutesAgo', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('statistics.lfmHoursAgo', { n: Math.floor(diff / 3600) });
  return t('statistics.lfmDaysAgo', { n: Math.floor(diff / 86400) });
}

const PERIODS: { key: LastfmPeriod; label: string }[] = [
  { key: '7day', label: 'lfmPeriod7day' },
  { key: '1month', label: 'lfmPeriod1month' },
  { key: '3month', label: 'lfmPeriod3month' },
  { key: '6month', label: 'lfmPeriod6month' },
  { key: '12month', label: 'lfmPeriod12month' },
  { key: 'overall', label: 'lfmPeriodOverall' },
];

export default function Statistics() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { lastfmSessionKey, lastfmUsername } = useAuthStore();
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const [recent, setRecent] = useState<SubsonicAlbum[]>([]);
  const [frequent, setFrequent] = useState<SubsonicAlbum[]>([]);
  const [highest, setHighest] = useState<SubsonicAlbum[]>([]);
  const [artistCount, setArtistCount] = useState<number | null>(null);
  const [totalSongs, setTotalSongs] = useState<number | null>(null);
  const [totalAlbums, setTotalAlbums] = useState<number | null>(null);
  const [genres, setGenres] = useState<SubsonicGenre[]>([]);
  const [loading, setLoading] = useState(true);

  const [totalPlaytime, setTotalPlaytime] = useState<number | null>(null);
  const [playtimeCapped, setPlaytimeCapped] = useState(false);
  const [formatData, setFormatData] = useState<{ format: string; count: number }[] | null>(null);
  const [formatSampleSize, setFormatSampleSize] = useState(0);

  const [exportOpen, setExportOpen] = useState(false);

  const [lfmPeriod, setLfmPeriod] = useState<LastfmPeriod>('1month');
  const [lfmTopArtists, setLfmTopArtists] = useState<LastfmTopArtist[]>([]);
  const [lfmTopAlbums, setLfmTopAlbums] = useState<LastfmTopAlbum[]>([]);
  const [lfmTopTracks, setLfmTopTracks] = useState<LastfmTopTrack[]>([]);
  const [lfmLoading, setLfmLoading] = useState(false);
  const [lfmRecentTracks, setLfmRecentTracks] = useState<LastfmRecentTrack[]>([]);
  const [lfmRecentLoading, setLfmRecentLoading] = useState(false);

  useEffect(() => {
    fetchStatisticsOverview()
      .then(d => {
        setRecent(d.recent);
        setFrequent(d.frequent);
        setHighest(d.highest);
        setArtistCount(d.artistCount);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [musicLibraryFilterVersion]);

  // Background: playtime, album/song counts, genre insights (cached per server+library like rating prefetch)
  useEffect(() => {
    let cancelled = false;
    setTotalPlaytime(null);
    setTotalAlbums(null);
    setTotalSongs(null);
    setPlaytimeCapped(false);
    setGenres([]);
    (async () => {
      try {
        const agg = await fetchStatisticsLibraryAggregates();
        if (cancelled) return;
        setTotalPlaytime(agg.playtimeSec);
        setTotalAlbums(agg.albumsCounted);
        setTotalSongs(agg.songsCounted);
        setPlaytimeCapped(agg.capped);
        setGenres(agg.genres);
      } catch {
        if (!cancelled) {
          setTotalPlaytime(0);
          setTotalAlbums(0);
          setTotalSongs(0);
          setPlaytimeCapped(false);
          setGenres([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [musicLibraryFilterVersion]);

  // Background: format distribution (cached random sample, same TTL as other Statistics fetches)
  useEffect(() => {
    let cancelled = false;
    setFormatData(null);
    setFormatSampleSize(0);
    fetchStatisticsFormatSample()
      .then(s => {
        if (cancelled) return;
        setFormatData(s.rows);
        setFormatSampleSize(s.sampleSize);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [musicLibraryFilterVersion]);

  useEffect(() => {
    if (!lastfmIsConfigured() || !lastfmSessionKey || !lastfmUsername) return;
    setLfmRecentLoading(true);
    lastfmGetRecentTracks(lastfmUsername, lastfmSessionKey, 20)
      .then(tracks => { setLfmRecentTracks(tracks); setLfmRecentLoading(false); })
      .catch(() => setLfmRecentLoading(false));
  }, [lastfmSessionKey, lastfmUsername]);

  useEffect(() => {
    if (!lastfmIsConfigured() || !lastfmSessionKey || !lastfmUsername) return;
    setLfmLoading(true);
    Promise.all([
      lastfmGetTopArtists(lastfmUsername, lastfmSessionKey, lfmPeriod, 10),
      lastfmGetTopAlbums(lastfmUsername, lastfmSessionKey, lfmPeriod, 10),
      lastfmGetTopTracks(lastfmUsername, lastfmSessionKey, lfmPeriod, 10),
    ]).then(([artists, albums, tracks]) => {
      setLfmTopArtists(artists);
      setLfmTopAlbums(albums);
      setLfmTopTracks(tracks);
      setLfmLoading(false);
    }).catch(() => setLfmLoading(false));
  }, [lfmPeriod, lastfmSessionKey, lastfmUsername]);

  const loadMore = async (
    type: 'frequent' | 'highest',
    currentList: SubsonicAlbum[],
    setter: React.Dispatch<React.SetStateAction<SubsonicAlbum[]>>
  ) => {
    try {
      const more = await getAlbumList(type, 12, currentList.length);
      const newItems = more.filter(m => !currentList.find(c => c.id === m.id));
      if (newItems.length > 0) setter(prev => [...prev, ...newItems]);
    } catch (e) {
      console.error('Failed to load more', e);
    }
  };

  const playtimeDisplay = totalPlaytime === null
    ? t('statistics.computing')
    : (playtimeCapped ? '≥ ' : '') + formatHumanHoursMinutes(totalPlaytime);

  const countDisplay = (n: number | null) =>
    n === null ? t('statistics.computing') : (playtimeCapped ? '≥ ' : '') + n.toLocaleString();

  const stats = [
    { label: t('statistics.statArtists'), value: artistCount?.toLocaleString() ?? '—', tooltip: t('statistics.statArtistsTooltip') },
    { label: t('statistics.statAlbums'), value: countDisplay(totalAlbums) },
    { label: t('statistics.statSongs'), value: countDisplay(totalSongs) },
    { label: t('statistics.statPlaytime'), value: playtimeDisplay },
  ];

  const topGenres = genres.slice(0, 10);
  const maxGenreSongs = topGenres[0]?.songCount ?? 1;

  return (
    <div className="content-body animate-fade-in">
      <h1 className="page-title">{t('statistics.title')}</h1>

      {loading ? (
        <div className="loading-center"><div className="spinner" /></div>
      ) : (
        <div className="stats-page">

          <div className="stats-overview">
            {stats.map(s => (
              <div key={s.label} className="stats-card">
                <span className="stats-card-value">{s.value}</span>
                <span className="stats-card-label" data-tooltip={s.tooltip} data-tooltip-wrap="true">{s.label}</span>
              </div>
            ))}
          </div>

          {/* Genre Insights + Format Distribution */}
          {(topGenres.length > 0 || formatData) && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem', marginBottom: '0.5rem' }}>

              {topGenres.length > 0 && (
                <div style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: '12px', padding: '1.25rem', backdropFilter: 'blur(8px)' }}>
                  <h3 style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--accent)', marginBottom: '1rem' }}>
                    {t('statistics.genreInsights')}
                  </h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                    {topGenres.map(g => (
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

              {formatData && (
                <div style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: '12px', padding: '1.25rem', backdropFilter: 'blur(8px)' }}>
                  <h3 style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--accent)', marginBottom: '0.25rem' }}>
                    {t('statistics.formatDistribution')}
                  </h3>
                  <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                    {t('statistics.formatSample', { n: formatSampleSize.toLocaleString() })}
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                    {formatData.map(f => {
                      const pct = formatSampleSize > 0 ? Math.round((f.count / formatSampleSize) * 100) : 0;
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

          {recent.length > 0 && (
            <AlbumRow title={t('statistics.recentlyPlayed')} albums={recent} />
          )}

          <AlbumRow
            title={t('statistics.mostPlayed')}
            albums={frequent}
            onLoadMore={() => loadMore('frequent', frequent, setFrequent)}
            moreText={t('statistics.loadMore')}
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
          />

          <AlbumRow
            title={t('statistics.highestRated')}
            albums={highest}
            onLoadMore={() => loadMore('highest', highest, setHighest)}
            moreText={t('statistics.loadMore')}
            showRating
          />

          {/* Last.fm Stats */}
          {lastfmIsConfigured() && (
            <section style={{ marginTop: '2rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
                <h2 className="section-title" style={{ margin: 0 }}>{t('statistics.lfmTitle')}</h2>
                {lastfmSessionKey && (
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
                )}
              </div>

              {!lastfmSessionKey ? (
                <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>{t('statistics.lfmNotConnected')}</p>
              ) : lfmLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--text-muted)', fontSize: '0.875rem', padding: '1rem 0' }}>
                  <div className="spinner" style={{ width: 16, height: 16, borderTopColor: 'currentColor' }} />
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1rem' }}>
                  {([
                    { label: t('statistics.lfmTopArtists'), items: lfmTopArtists.map(a => ({ primary: a.name, secondary: null, playcount: a.playcount })) },
                    { label: t('statistics.lfmTopAlbums'),  items: lfmTopAlbums.map(a =>  ({ primary: a.name, secondary: a.artist, playcount: a.playcount })) },
                    { label: t('statistics.lfmTopTracks'),  items: lfmTopTracks.map(tr => ({ primary: tr.name, secondary: tr.artist, playcount: tr.playcount })) },
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
          {lastfmIsConfigured() && lastfmSessionKey && (
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
                            <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4, background: 'var(--accent)', color: 'var(--ctp-base)', opacity: 0.85, letterSpacing: '0.04em', textTransform: 'uppercase', flexShrink: 0 }}>{t('statistics.lfmNowPlaying')}</span>
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
      <StatsExportModal
        open={exportOpen}
        albums={frequent}
        onClose={() => setExportOpen(false)}
      />
    </div>
  );
}
