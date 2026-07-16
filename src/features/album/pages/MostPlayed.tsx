import { getAlbumList } from '@/lib/api/subsonicLibrary';
import { resolveAlbum } from '@/features/offline';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { songToTrack } from '@/lib/media/songToTrack';
import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpDown, ArrowDown, ArrowUp, TrendingUp, UsersRound, Play, ListPlus } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { AlbumCoverArtImage } from '@/cover/AlbumCoverArtImage';
import { ArtistCoverArtImage } from '@/cover/ArtistCoverArtImage';
import { playAlbum, playAlbumShuffled } from '@/features/playback/utils/playback/playAlbum';
import { useLongPressAction } from '@/lib/hooks/useLongPressAction';
import { LongPressWaveOverlay } from '@/ui/LongPressWaveOverlay';
import { useTranslation } from 'react-i18next';
import { albumArtistDisplayName } from '@/features/album/utils/deriveAlbumHeaderArtistRefs';

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

/** Most-played list row cover layout px. */
const MOST_PLAYED_COVER_CSS_PX = 80;

function MostPlayedPlayButton({ albumId }: { albumId: string }) {
  const { t } = useTranslation();
  const { isHolding, pressBind } = useLongPressAction({
    onShortPress: () => playAlbum(albumId),
    onLongPress: () => playAlbumShuffled(albumId),
  });

  return (
    <button
      type="button"
      className="mp-album-action-btn long-press-play-btn"
      {...pressBind}
      data-tooltip={t('hero.playAlbumTooltip')}
      data-tooltip-pos="top"
      aria-label={t('hero.playAlbumTooltip')}
    >
      <LongPressWaveOverlay active={isHolding} size="compact" />
      <span className="long-press-play-btn__icon">
        <Play size={14} fill="currentColor" />
      </span>
    </button>
  );
}


export default function MostPlayed() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const enqueue = usePlayerStore(s => s.enqueue);

  const handleEnqueueAlbum = useCallback(async (albumId: string) => {
    if (!activeServerId) return;
    try {
      const data = await resolveAlbum(activeServerId, albumId);
      if (!data) return;
      enqueue(data.songs.map(songToTrack));
    } catch {
      // Network failure — silent (toast would be too noisy for a hover action).
    }
  }, [activeServerId, enqueue]);

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
    } catch { /* ignore: best-effort */ }
    setLoading(false);
    // musicLibraryFilterVersion is an intentional re-create trigger: getAlbumList
    // reads the active library filter internally, so `load` must refresh (and the
    // mount effect re-run) when that version bumps even though it is unused here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [musicLibraryFilterVersion]);

  // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const result = await getAlbumList('frequent', PAGE_SIZE, albums.length);
      setAlbums(prev => [...prev, ...result]);
      setHasMore(result.length === PAGE_SIZE);
    } catch { /* ignore: best-effort */ }
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
          className="btn btn-surface mp-sort-btn"
          onClick={() => setSortAsc(v => !v)}
          aria-label={sortAsc ? t('mostPlayed.sortLeast') : t('mostPlayed.sortMost')}
          data-tooltip={sortAsc ? t('mostPlayed.sortMost') : t('mostPlayed.sortLeast')}
        >
          {sortAsc ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
          <span className="compact-btn-label">{sortAsc ? t('mostPlayed.sortLeast') : t('mostPlayed.sortMost')}</span>
          <ArrowUpDown size={12} style={{ opacity: 0.45 }} />
        </button>
      </div>

      {/* ── Top Artists ── */}
      {!loading && (
        <section className="mp-section">
          <div className="mp-section-header">
            <h2 className="mp-section-title">{t('mostPlayed.topArtists')}</h2>
            <button
              className={`btn btn-surface mp-filter-btn${filterCompilations ? ' mp-filter-btn--active' : ''}`}
              onClick={() => setFilterCompilations(v => !v)}
              aria-label={t('mostPlayed.filterCompilations')}
              data-tooltip={t('mostPlayed.filterCompilations')}
              data-tooltip-pos="left"
            >
              <UsersRound size={14} />
              <span className="compact-btn-label">{t('mostPlayed.filterCompilationsShort')}</span>
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
                  <ArtistCoverArtImage
                    artistId={artist.id}
                    coverArt={artist.coverArt}
                    displayCssPx={MOST_PLAYED_COVER_CSS_PX}
                    surface="dense"
                    alt=""
                    className="mp-artist-avatar"
                  />
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
                    <AlbumCoverArtImage
                      albumId={album.id}
                      coverArt={album.coverArt}
                      displayCssPx={MOST_PLAYED_COVER_CSS_PX}
                      surface="dense"
                      alt=""
                      className="mp-album-cover"
                    />
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
                      {albumArtistDisplayName(album)}
                    </span>
                  </div>
                  <div className="mp-album-actions">
                    <MostPlayedPlayButton albumId={album.id} />
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
