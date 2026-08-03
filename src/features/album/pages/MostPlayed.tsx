import { fetchMostPlayedAlbums } from '@/lib/api/subsonicStatistics';
import type {
  LibraryScopeMostPlayedAlbum,
  LibraryScopeMostPlayedArtist,
} from '@/lib/api/library/scopeReads';
import { resolveAlbum } from '@/features/offline';
import type { SubsonicAlbum } from '@/lib/api/subsonicTypes';
import { songToTrack } from '@/lib/media/songToTrack';
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router';
import { ArrowUpDown, ArrowDown, ArrowUp, TrendingUp, UsersRound, Play, ListPlus } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { CoverArtImage } from '@/cover/CoverArtImage';
import { useAlbumCoverRef, useArtistCoverRef } from '@/cover/useLibraryCoverRef';
import { playAlbum, playAlbumShuffled } from '@/features/playback/utils/playback/playAlbum';
import { useLongPressAction } from '@/lib/hooks/useLongPressAction';
import { LongPressWaveOverlay } from '@/ui/LongPressWaveOverlay';
import { useTranslation } from 'react-i18next';
import {
  albumArtistDisplayName, deriveAlbumArtistRefs,
} from '@/features/album/utils/deriveAlbumHeaderArtistRefs';
import { ResolvedArtistRefInline } from '@/ui/ResolvedArtistRefInline';
import { appendServerQuery } from '@/lib/navigation/detailServerScope';
import { coverServerScopeForOwnerServerId } from '@/cover/serverScope';
import { wakeCoverBackfillForMissingMetadata } from '@/cover/wakeCoverBackfillForMissingMetadata';

const PAGE_SIZE = 50;

type MostPlayedAlbum = Omit<SubsonicAlbum, 'serverId'> & {
  serverId: string;
  libraryId: string;
};

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

function mapMostPlayedAlbum(album: LibraryScopeMostPlayedAlbum): MostPlayedAlbum {
  return {
    id: album.id,
    name: album.name,
    artist: album.artist,
    artistId: album.artistId ?? '',
    coverArt: album.coverArtId ?? undefined,
    songCount: 0,
    duration: 0,
    playCount: album.playCount,
    year: album.year ?? undefined,
    serverId: album.serverId,
    libraryId: album.libraryId,
  };
}

function formatPlays(n: number, t: ReturnType<typeof import('react-i18next').useTranslation>['t']): string {
  return t('mostPlayed.plays', { n: n.toLocaleString() }) as string;
}

function detailPath(kind: 'album' | 'artist', id: string, serverId: string): string {
  const query = appendServerQuery(undefined, serverId);
  return `/${kind}/${id}${query ? `?${query}` : ''}`;
}

/** Most-played list row cover layout px. */
const MOST_PLAYED_COVER_CSS_PX = 80;

function MostPlayedAlbumCover({ album }: { album: MostPlayedAlbum }) {
  const serverScope = useMemo(
    () => coverServerScopeForOwnerServerId(album.serverId),
    [album.serverId],
  );
  const coverRef = useAlbumCoverRef(
    album.id,
    album.coverArt,
    serverScope,
    { libraryResolve: true },
  );

  useEffect(() => {
    if (!album.coverArt?.trim()) {
      wakeCoverBackfillForMissingMetadata(album.serverId);
    }
  }, [album.coverArt, album.serverId]);

  return (
    <CoverArtImage
      coverRef={coverRef}
      displayCssPx={MOST_PLAYED_COVER_CSS_PX}
      surface="dense"
      alt=""
      className="mp-album-cover"
    />
  );
}

function MostPlayedArtistCover({ artist }: { artist: LibraryScopeMostPlayedArtist }) {
  const serverScope = useMemo(
    () => coverServerScopeForOwnerServerId(artist.serverId),
    [artist.serverId],
  );
  const coverRef = useArtistCoverRef(
    artist.id,
    artist.coverArtId,
    serverScope,
    { libraryResolve: true },
  );

  useEffect(() => {
    if (!artist.coverArtId?.trim()) {
      wakeCoverBackfillForMissingMetadata(artist.serverId);
    }
  }, [artist.coverArtId, artist.serverId]);

  return (
    <CoverArtImage
      coverRef={coverRef}
      displayCssPx={MOST_PLAYED_COVER_CSS_PX}
      surface="dense"
      alt=""
      className="mp-artist-avatar"
    />
  );
}

function MostPlayedPlayButton({ albumId, serverId }: { albumId: string; serverId: string }) {
  const { t } = useTranslation();
  const { isHolding, pressBind } = useLongPressAction({
    onShortPress: () => playAlbum(albumId, { serverId }),
    onLongPress: () => playAlbumShuffled(albumId, { serverId }),
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
  const libraryBrowseScopeVersion = useAuthStore(s => s.libraryBrowseScopeVersion);
  const activeServerId = useAuthStore(s => s.activeServerId ?? '');
  const openContextMenu = usePlayerStore(s => s.openContextMenu);
  const enqueue = usePlayerStore(s => s.enqueue);

  const handleEnqueueAlbum = useCallback(async (albumId: string, ownerServerId: string) => {
    try {
      const data = await resolveAlbum(ownerServerId, albumId);
      if (!data) return;
      enqueue(data.songs.map(songToTrack));
    } catch {
      // Network failure — silent (toast would be too noisy for a hover action).
    }
  }, [enqueue]);

  const [albums, setAlbums] = useState<MostPlayedAlbum[]>([]);
  const [artists, setArtists] = useState<LibraryScopeMostPlayedArtist[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [sortAsc, setSortAsc] = useState(false); // false = most plays first
  const [filterCompilations, setFilterCompilations] = useState(false);

  const topArtists = artists
    .filter(artist => !filterCompilations || !isCompilation(artist.name))
    .slice(0, 10);

  const load = useCallback(async () => {
    setLoading(true);
    setAlbums([]);
    setArtists([]);
    setHasMore(true);
    try {
      const result = await fetchMostPlayedAlbums(PAGE_SIZE, 0);
      setAlbums(result.albums.map(mapMostPlayedAlbum));
      setArtists(result.artists);
      setHasMore(result.hasMore);
    } catch { /* ignore: best-effort */ }
    setLoading(false);
    // Scope state is read by the local-index API layer; retain both versions as
    // explicit reload triggers when users change selected servers or folders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryBrowseScopeVersion, musicLibraryFilterVersion]);

  // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const result = await fetchMostPlayedAlbums(PAGE_SIZE, albums.length);
      setAlbums(prev => [...prev, ...result.albums.map(mapMostPlayedAlbum)]);
      setHasMore(result.hasMore);
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
                key={`${artist.serverId}\u0000${artist.id}`}
                className="mp-artist-card"
                onClick={() => navigate(detailPath('artist', artist.id, artist.serverId))}
                onContextMenu={e => {
                  e.preventDefault();
                  openContextMenu(e.clientX, e.clientY, artist, 'artist');
                }}
              >
                <span className="mp-rank">{i + 1}</span>
                <MostPlayedArtistCover artist={artist} />
                <div className="mp-artist-info">
                  <span className="mp-artist-name truncate">{artist.name}</span>
                  <span className="mp-artist-plays">{formatPlays(artist.playCount, t)}</span>
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
                  key={`${album.serverId}\u0000${album.libraryId}\u0000${album.id}`}
                  className="mp-album-row"
                  onClick={() => navigate(detailPath('album', album.id, album.serverId))}
                  onContextMenu={e => {
                    e.preventDefault();
                    openContextMenu(e.clientX, e.clientY, album, 'album');
                  }}
                >
                  <span className="mp-album-rank">{sortAsc ? withPlays.length - i : i + 1}</span>
                  <MostPlayedAlbumCover album={album} />
                  <div className="mp-album-meta">
                    <div className="mp-album-name-row">
                      <span className="mp-album-name truncate">{album.name}</span>
                      <span className="mp-album-plays-pill">
                        <Play size={11} fill="currentColor" />
                        {t('mostPlayed.plays', { n: (album.playCount ?? 0).toLocaleString() })}
                      </span>
                    </div>
                    <span className="mp-album-artist truncate">
                      <ResolvedArtistRefInline
                        refs={deriveAlbumArtistRefs(album)}
                        serverId={album.serverId ?? activeServerId}
                        fallbackName={albumArtistDisplayName(album)}
                        onGoArtist={id => navigate(detailPath('artist', id, album.serverId))}
                        as="none"
                        linkTag="span"
                        linkClassName="track-artist-link"
                      />
                    </span>
                  </div>
                  <div className="mp-album-actions">
                    <MostPlayedPlayButton albumId={album.id} serverId={album.serverId} />
                    <button
                      className="mp-album-action-btn"
                      onClick={e => { e.stopPropagation(); void handleEnqueueAlbum(album.id, album.serverId); }}
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
