import type { SubsonicAlbum } from '../api/subsonicTypes';
import { songToTrack } from '../utils/songToTrack';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpDown, ArrowDown, ArrowUp, TrendingUp, UsersRound, Play, ListPlus } from 'lucide-react';
import { getAlbumList, getAlbum, buildCoverArtUrl, coverArtCacheKey } from '../api/subsonic';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import CachedImage from '../components/CachedImage';
import { playAlbum } from '../utils/playAlbum';
import { useTranslation } from 'react-i18next';

const PAGE_SIZE = 50;

interface ArtistEntry {
  id: string;
  name: string;
  coverArt?: string;
  totalPlays: number;
}

const COMPILATION_NAMES = new Set([
  'various artists', 'various', 'va', 'v.a.', 'v.a',
  'diverse artister', 'diversos artistas', 'artistes variés',
  'vários artistas', 'verschiedene künstler', 'verscheidene artiesten',
  'compilations', 'soundtrack', 'original soundtrack', 'ost',
  'original motion picture soundtrack', 'original score',
]);

function isCompilation(name: string): boolean {
  return COMPILATION_NAMES.has(name.toLowerCase().trim());
}

function deriveTopArtists(albums: SubsonicAlbum[], filterCompilations: boolean): ArtistEntry[] {
  const map = new Map<string, ArtistEntry>();
  for (const a of albums) {
    const plays = a.playCount ?? 0;
    if (plays === 0) continue;
    if (filterCompilations && isCompilation(a.artist ?? '')) continue;
    const entry = map.get(a.artistId);
    if (entry) {
      entry.totalPlays += plays;
      if (!entry.coverArt && a.coverArt) entry.coverArt = a.coverArt;
    } else {
      map.set(a.artistId, { id: a.artistId, name: a.artist, coverArt: a.coverArt, totalPlays: plays });
    }
  }
  return [...map.values()].sort((a, b) => b.totalPlays - a.totalPlays);
}

function formatPlays(n: number, t: ReturnType<typeof import('react-i18next').useTranslation>['t']): string {
  return t('mostPlayed.plays', { n: n.toLocaleString() }) as string;
}

function MpCover80({ coverArt, alt, className }: { coverArt: string; alt: string; className: string }) {
  const src = useMemo(() => buildCoverArtUrl(coverArt, 80), [coverArt]);
  const cacheKey = useMemo(() => coverArtCacheKey(coverArt, 80), [coverArt]);
  return <CachedImage src={src} cacheKey={cacheKey} alt={alt} className={className} />;
}

export default function MostPlayed() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const enqueue = usePlayerStore(s => s.enqueue);

  const handleEnqueueAlbum = useCallback(async (albumId: string) => {
    try {
      const data = await getAlbum(albumId);
      enqueue(data.songs.map(songToTrack));
    } catch {
      // Network failure — silent (toast would be too noisy for a hover action).
    }
  }, [enqueue]);

  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [sortAsc, setSortAsc] = useState(false); // false = most plays first
  const [filterCompilations, setFilterCompilations] = useState(false);

  const topArtists = deriveTopArtists(albums, filterCompilations).slice(0, 10);

  const load = useCallback(async () => {
    setLoading(true);
    setAlbums([]);
    setHasMore(true);
    try {
      const result = await getAlbumList('frequent', PAGE_SIZE, 0);
      setAlbums(result);
      setHasMore(result.length === PAGE_SIZE);
    } catch {}
    setLoading(false);
  }, [musicLibraryFilterVersion]);

  useEffect(() => { load(); }, [load]);

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const result = await getAlbumList('frequent', PAGE_SIZE, albums.length);
      setAlbums(prev => [...prev, ...result]);
      setHasMore(result.length === PAGE_SIZE);
    } catch {}
    setLoadingMore(false);
  };

  const sorted = sortAsc ? [...albums].reverse() : albums;
  const withPlays = sorted.filter(a => (a.playCount ?? 0) > 0);

  return (
    <div className="content-body animate-fade-in">
      <div className="mp-header">
        <div className="mp-header-left">
          <TrendingUp size={22} className="mp-header-icon" />
          <h1 className="mp-title">{t('mostPlayed.title')}</h1>
        </div>
        <button
          className="btn btn-ghost mp-sort-btn"
          onClick={() => setSortAsc(v => !v)}
          data-tooltip={sortAsc ? t('mostPlayed.sortMost') : t('mostPlayed.sortLeast')}
        >
          {sortAsc ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
          {sortAsc ? t('mostPlayed.sortLeast') : t('mostPlayed.sortMost')}
          <ArrowUpDown size={12} style={{ opacity: 0.45 }} />
        </button>
      </div>

      {/* ── Top Artists ── */}
      {!loading && (
        <section className="mp-section">
          <div className="mp-section-header">
            <h2 className="mp-section-title">{t('mostPlayed.topArtists')}</h2>
            <button
              className={`btn btn-ghost mp-filter-btn${filterCompilations ? ' mp-filter-btn--active' : ''}`}
              onClick={() => setFilterCompilations(v => !v)}
              data-tooltip={t('mostPlayed.filterCompilations')}
              data-tooltip-pos="left"
            >
              <UsersRound size={14} />
              {t('mostPlayed.filterCompilationsShort')}
            </button>
          </div>
          {topArtists.length === 0 && (
            <div className="empty-state" style={{ padding: '12px 0' }}>{t('mostPlayed.noArtists')}</div>
          )}
          <div className="mp-artist-grid">
            {topArtists.map((artist, i) => (
              <button
                key={artist.id}
                className="mp-artist-card"
                onClick={() => navigate(`/artist/${artist.id}`)}
                onContextMenu={e => {
                  e.preventDefault();
                  openContextMenu(e.clientX, e.clientY, artist, 'artist');
                }}
              >
                <span className="mp-rank">{i + 1}</span>
                {artist.coverArt ? (
                  <MpCover80 coverArt={artist.coverArt} alt="" className="mp-artist-avatar" />
                ) : (
                  <div className="mp-artist-avatar mp-artist-avatar--placeholder" />
                )}
                <div className="mp-artist-info">
                  <span className="mp-artist-name truncate">{artist.name}</span>
                  <span className="mp-artist-plays">{formatPlays(artist.totalPlays, t)}</span>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* ── Top Albums ── */}
      <section className="mp-section">
        <h2 className="mp-section-title">{t('mostPlayed.topAlbums')}</h2>

        {loading ? (
          <div className="mp-loading"><div className="spinner" /></div>
        ) : withPlays.length === 0 ? (
          <div className="empty-state">{t('mostPlayed.noData')}</div>
        ) : (
          <>
            <div className="mp-album-list">
              {withPlays.map((album, i) => (
                <div
                  key={album.id}
                  className="mp-album-row"
                  onClick={() => navigate(`/album/${album.id}`)}
                  onContextMenu={e => {
                    e.preventDefault();
                    openContextMenu(e.clientX, e.clientY, album, 'album');
                  }}
                >
                  <span className="mp-album-rank">{sortAsc ? withPlays.length - i : i + 1}</span>
                  {album.coverArt ? (
                    <MpCover80 coverArt={album.coverArt} alt="" className="mp-album-cover" />
                  ) : (
                    <div className="mp-album-cover mp-album-cover--placeholder" />
                  )}
                  <div className="mp-album-meta">
                    <div className="mp-album-name-row">
                      <span className="mp-album-name truncate">{album.name}</span>
                      <span className="mp-album-plays-pill">
                        <Play size={11} fill="currentColor" />
                        {t('mostPlayed.plays', { n: (album.playCount ?? 0).toLocaleString() })}
                      </span>
                    </div>
                    <span
                      className="mp-album-artist truncate track-artist-link"
                      onClick={e => { e.stopPropagation(); navigate(`/artist/${album.artistId}`); }}
                    >
                      {album.artist}
                    </span>
                  </div>
                  <div className="mp-album-actions">
                    <button
                      className="mp-album-action-btn"
                      onClick={e => { e.stopPropagation(); playAlbum(album.id); }}
                      data-tooltip={t('hero.playAlbum')}
                      data-tooltip-pos="top"
                      aria-label={t('hero.playAlbum')}
                    >
                      <Play size={14} fill="currentColor" />
                    </button>
                    <button
                      className="mp-album-action-btn"
                      onClick={e => { e.stopPropagation(); void handleEnqueueAlbum(album.id); }}
                      data-tooltip={t('contextMenu.enqueueAlbum')}
                      data-tooltip-pos="top"
                      aria-label={t('contextMenu.enqueueAlbum')}
                    >
                      <ListPlus size={14} />
                    </button>
                  </div>
                  {album.year && <span className="mp-album-year">{album.year}</span>}
                </div>
              ))}
            </div>

            {hasMore && (
              <button
                className="btn btn-ghost mp-load-more"
                onClick={loadMore}
                disabled={loadingMore}
              >
                {loadingMore ? <div className="spinner" style={{ width: 14, height: 14, borderTopColor: 'currentColor' }} /> : null}
                {t('mostPlayed.loadMore')}
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}
