import { useCoverArt } from '../cover/useCoverArt';
import { useArtistCoverRef } from '../cover/useLibraryCoverRef';
import type { SubsonicArtist, SubsonicAlbum } from '../api/subsonicTypes';
import { useEffect, useState, Fragment, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import AlbumCard from '../components/AlbumCard';
import { ArrowDownUp } from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { usePlayerStore } from '../store/playerStore';
import { useAuthStore } from '../store/authStore';
import { useTranslation } from 'react-i18next';
import { useArtistLayoutStore, type ArtistSectionId } from '../store/artistLayoutStore';
import {
  DEFAULT_ARTIST_ALBUM_YEAR_ORDER,
  useArtistAlbumYearSortStore,
} from '../store/artistAlbumYearSortStore';

import { useArtistDetailData } from '../hooks/useArtistDetailData';
import { useArtistSimilarArtists } from '../hooks/useArtistSimilarArtists';
import {
  runArtistDetailPlayAll, runArtistDetailPlayTopSong, runArtistDetailShuffle, runArtistDetailStartRadio,
} from '../utils/componentHelpers/runArtistDetailPlay';
import { useOfflineBrowseContext } from '../hooks/useOfflineBrowseContext';
import { offlineActionPolicy } from '../utils/offline/offlineActionPolicy';
import {
  runArtistEntityRating, runArtistToggleStar, runArtistShare, runArtistImageUpload,
} from '../utils/componentHelpers/runArtistDetailActions';
import ArtistDetailHero from '../components/artistDetail/ArtistDetailHero';
import ArtistDetailTopTracks from '../components/artistDetail/ArtistDetailTopTracks';
import ArtistDetailSimilarArtists from '../components/artistDetail/ArtistDetailSimilarArtists';
import ArtistCard from '../components/nowPlaying/ArtistCard';
import LosslessModeBanner from '../components/LosslessModeBanner';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import { albumGridWarmCovers, COVER_DENSE_GRID_MIN_CELL_CSS_PX, GRID_COVER_WARM_LIMIT } from '../cover/layoutSizes';
import { artistDetailCoverWarmAlbums } from '../components/artistDetail/topSongAlbumForCover';
import { useLibraryCoverPrefetch } from '../cover/useLibraryCoverPrefetch';
import { useWarmGridCovers } from '../hooks/useWarmGridCovers';
import { VirtualCardGrid } from '../components/VirtualCardGrid';
import { LOSSLESS_MODE_QUERY } from '../utils/library/losslessMode';
import { sortArtistAlbumsByYear } from '../utils/library/sortArtistAlbums';
import { readDetailServerId } from '../utils/navigation/detailServerScope';


export default function ArtistDetail() {
  const { t } = useTranslation();
  const perfFlags = usePerfProbeFlags();
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const losslessOnly = searchParams.get('lossless') === '1';
  const {
    artist, setArtist, albums, topSongs, info, featuredAlbums,
    loading, artistInfoLoading, featuredLoading,
    isStarred, setIsStarred,
  } = useArtistDetailData(id, { losslessOnly });
  const [radioLoading, setRadioLoading] = useState(false);
  const [playAllLoading, setPlayAllLoading] = useState(false);
  const [openedLink, setOpenedLink] = useState<string | null>(null);
  const { similarArtists, similarLoading } = useArtistSimilarArtists(artist, info, artistInfoLoading);
  const [uploading, setUploading] = useState(false);
  const [similarCollapsed, setSimilarCollapsed] = useState(true);
  const [coverRevision, setCoverRevision] = useState(0);
  /** True after header cover onError — avoid `display:none` on the img (breaks recovery). */
  const [headerCoverFailed, setHeaderCoverFailed] = useState(false);

  const playTrack = usePlayerStore(state => state.playTrack);
  const enqueue = usePlayerStore(state => state.enqueue);
  const authActiveServerId = useAuthStore(s => s.activeServerId);
  const activeServerId = readDetailServerId(searchParams, authActiveServerId) ?? '';
  const audiomuseNavidromeEnabled = useAuthStore(
    s => !!(activeServerId && s.audiomuseNavidromeByServer[activeServerId]),
  );
  const enrichmentConfigured = useAuthStore(s => s.enrichmentPrimaryId !== null);
  const albumYearOrder = useArtistAlbumYearSortStore(
    s => s.orderByServer[activeServerId] ?? DEFAULT_ARTIST_ALBUM_YEAR_ORDER,
  );
  const toggleAlbumYearOrder = useArtistAlbumYearSortStore(s => s.toggleYearOrder);
  // MUST stay above the loading / !artist early returns or React's hook
  // call order will mismatch between renders.
  const sectionConfig = useArtistLayoutStore(s => s.sections);
  const entityRatingSupportByServer = useAuthStore(s => s.entityRatingSupportByServer);
  const artistEntityRatingSupport = entityRatingSupportByServer[activeServerId] ?? 'unknown';
  const offlineCtx = useOfflineBrowseContext();
  const artistActionPolicy = offlineActionPolicy('artistDetail', offlineCtx.active);

  const [artistEntityRating, setArtistEntityRating] = useState(0);

  useEffect(() => {
    if (!id) return;
    // React Compiler set-state-in-effect rule: local state synced with store/prop inputs when the effect’s dependencies change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (artist && artist.id === id) setArtistEntityRating(artist.userRating ?? 0);
    // Keyed on the artist's id / userRating primitives; depending on the `artist`
    // object would re-run on every render when its identity changes but those do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, artist?.id, artist?.userRating]);

  const handleArtistEntityRating = (rating: number) => runArtistEntityRating({
    artist, id, rating, artistEntityRatingSupport, activeServerId, t,
    setArtistEntityRating, setArtist,
  });

  const openLink = (url: string, key: string) => {
    open(url);
    setOpenedLink(key);
    setTimeout(() => setOpenedLink(null), 2500);
  };

  const toggleStar = () => runArtistToggleStar({ artist, isStarred, setIsStarred });

  const handlePlayAll = () => runArtistDetailPlayAll({
    albums, serverId: activeServerId, setPlayAllLoading, playTrack,
  });
  const handleShuffle = () => runArtistDetailShuffle({
    albums, serverId: activeServerId, setPlayAllLoading, playTrack,
  });
  const handleStartRadio = () => {
    if (!artist) return;
    return runArtistDetailStartRadio({ artist, t, setRadioLoading, playTrack, enqueue });
  };

  const handleShareArtist = () => {
    if (!id || !artist) return;
    return runArtistShare({ artist, t });
  };

  const playTopSongWithContinuation = (startIndex: number) => runArtistDetailPlayTopSong({
    topSongs,
    albums,
    serverId: activeServerId,
    startIndex,
    setPlayAllLoading,
    playTrack,
  });

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => runArtistImageUpload({
    e, artist, t, setUploading, setCoverRevision,
  });

  // Cover URLs — must run every render (before early returns) or hook order breaks.
  const coverId = artist ? (artist.coverArt || artist.id) : '';
  const artistCoverRefResolved = useArtistCoverRef(artist?.id, artist?.coverArt, undefined, {
    libraryResolve: true,
  });
  const artistCoverFallback = useCoverArt(artistCoverRefResolved, 80, { surface: 'sparse' });

  const groupedAlbums = useMemo(() => {
    if (albums.length === 0) return [];
    const RELEASE_TYPE_ORDER = ['album', 'ep', 'single', 'compilation', 'live', 'soundtrack', 'remix', 'other'];
    const defaultKey = 'album';
    const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    const translateType = (tag: string) =>
      t(`artistDetail.releaseTypes.${tag}`, { defaultValue: titleCase(tag) });

    const groups = new Map<string, SubsonicAlbum[]>();
    for (const album of albums) {
      const key = album.releaseTypes?.length
        ? album.releaseTypes.map(r => r.toLowerCase()).join(' · ')
        : defaultKey;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(album);
    }

    const sortGroup = (group: SubsonicAlbum[]) =>
      sortArtistAlbumsByYear(group, albumYearOrder);

    if (groups.size === 1 && groups.has(defaultKey)) {
      return [[translateType(defaultKey), sortGroup(albums)] as const];
    }

    const sortKey = (key: string) => {
      const idx = RELEASE_TYPE_ORDER.indexOf(key.split(' · ')[0]);
      return idx >= 0 ? idx : RELEASE_TYPE_ORDER.length;
    };

    return [...groups.entries()]
      .sort((a, b) => sortKey(a[0]) - sortKey(b[0]) || a[0].localeCompare(b[0]))
      .map(([key, group]) => [
        key.split(' · ').map(translateType).join(' · '),
        sortGroup(group),
      ] as const);
  }, [albums, albumYearOrder, t]);

  useEffect(() => {
    // React Compiler set-state-in-effect rule: state set from an async result resolved in this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHeaderCoverFailed(false);
  }, [coverId, coverRevision, id]);

  const artistCoverWarmAlbums = useMemo(
    () => artistDetailCoverWarmAlbums(topSongs, albums, GRID_COVER_WARM_LIMIT),
    [topSongs, albums],
  );
  useWarmGridCovers(artistCoverWarmAlbums, COVER_DENSE_GRID_MIN_CELL_CSS_PX, {
    enabled: artistCoverWarmAlbums.length > 0,
    limit: GRID_COVER_WARM_LIMIT,
    surface: 'dense',
  });
  useLibraryCoverPrefetch(
    [
      {
        albums: artistCoverWarmAlbums.slice(0, 24),
        limit: 24,
        priority: 'high',
        surface: 'dense',
      },
    ],
    [artistCoverWarmAlbums],
  );

  if (loading) {
    return (
      <div className="content-body" style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
        <div className="spinner" />
      </div>
    );
  }

  if (!artist) {
    return (
      <div className="content-body">
        <div style={{ textAlign: 'center', padding: '4rem', color: 'var(--text-muted)' }}>
          {t('artistDetail.notFound')}
        </div>
      </div>
    );
  }

  const serverSimilarArtists: SubsonicArtist[] = (info?.similarArtist ?? []).map(sa => ({
    id: sa.id,
    name: sa.name,
    albumCount: sa.albumCount,
  }));
  const showAudiomuseSimilar = audiomuseNavidromeEnabled && serverSimilarArtists.length > 0;
  const showNetworkSimilar =
    enrichmentConfigured &&
    (!audiomuseNavidromeEnabled || serverSimilarArtists.length === 0) &&
    (similarLoading || similarArtists.length > 0);
  const showSimilarSection = showAudiomuseSimilar || showNetworkSimilar;

  // ── User-customisable section order + visibility ────────────────────────────
  // (`sectionConfig` is read at the top of the component — see comment there)
  const sectionHasData = (id: ArtistSectionId): boolean => {
    switch (id) {
      case 'bio':       return !!info?.biography;
      case 'topTracks': return topSongs.length > 0;
      case 'similar':   return showSimilarSection;
      case 'albums':    return true; // always renders (empty state included)
      case 'featured':  return featuredLoading || featuredAlbums.length > 0;
    }
  };
  // The order the user actually sees: hidden-via-toggle and empty sections
  // are filtered out, so the "first rendered section gets marginTop: 0" rule
  // works regardless of the configured order.
  const renderableSectionIds = sectionConfig
    .filter(s => s.visible)
    .map(s => s.id)
    .filter(sectionHasData);
  const sectionMt = (id: ArtistSectionId) => renderableSectionIds[0] === id ? '0' : '2rem';

  return (
    <div className="content-body animate-fade-in">
      <ArtistDetailHero
        artist={artist}
        id={id}
        albums={albums}
        info={info}
        isStarred={isStarred}
        artistEntityRating={artistEntityRating}
        handleArtistEntityRating={handleArtistEntityRating}
        toggleStar={toggleStar}
        handlePlayAll={handlePlayAll}
        handleShuffle={handleShuffle}
        handleStartRadio={handleStartRadio}
        handleShareArtist={handleShareArtist}
        handleImageUpload={handleImageUpload}
        playAllLoading={playAllLoading}
        radioLoading={radioLoading}
        uploading={uploading}
        openedLink={openedLink}
        openLink={openLink}
        coverId={coverId}
        coverRef={artistCoverRefResolved}
        coverRevision={coverRevision}
        headerCoverFailed={headerCoverFailed}
        setHeaderCoverFailed={setHeaderCoverFailed}
        actionPolicy={artistActionPolicy}
      />

      {losslessOnly && <LosslessModeBanner />}

      {/* User-reorderable sections — order + visibility configured in Settings.
       * Each case renders the same JSX it did pre-refactor; only `marginTop`
       * (now derived from the actual render order) and the outer wrapper changed. */}
      {renderableSectionIds.map(sectionId => {
        switch (sectionId) {
          case 'bio': return (
            <div key="bio" style={{ marginTop: sectionMt('bio') }}>
              <ArtistCard
                artistName={artist.name}
                artistId={id}
                artistInfo={info}
                hideArtistName
                hideSimilar
                coverFallback={coverId ? { src: artistCoverFallback.src, cacheKey: artistCoverFallback.cacheKey } : undefined}
              />
            </div>
          );

          case 'topTracks': return (
            <ArtistDetailTopTracks
              key="topTracks"
              topSongs={topSongs}
              albums={albums}
              marginTop={sectionMt('topTracks')}
              playTopSongWithContinuation={playTopSongWithContinuation}
              losslessOnly={losslessOnly}
            />
          );

          case 'similar': return (
            <ArtistDetailSimilarArtists
              key="similar"
              marginTop={sectionMt('similar')}
              showAudiomuseSimilar={showAudiomuseSimilar}
              showNetworkSimilar={showNetworkSimilar}
              similarLoading={similarLoading}
              similarArtists={similarArtists}
              serverSimilarArtists={serverSimilarArtists}
              similarCollapsed={similarCollapsed}
              setSimilarCollapsed={setSimilarCollapsed}
            />
          );

          case 'albums': return (
            <Fragment key="albums">
              <div
                style={{
                  marginTop: sectionMt('albums'),
                  marginBottom: '1rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '0.75rem',
                  flexWrap: 'wrap',
                }}
              >
                <h2 className="section-title" style={{ margin: 0 }}>
                  {losslessOnly
                    ? t('artistDetail.albumsByLossless', { name: artist.name })
                    : t('artistDetail.albumsBy', { name: artist.name })}
                </h2>
                {albums.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-surface btn-sort-active"
                    onClick={() => toggleAlbumYearOrder(activeServerId)}
                    aria-label={t('artistDetail.sortYearToggleAria')}
                    style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
                  >
                    <ArrowDownUp size={14} />
                    {albumYearOrder === 'yearDesc'
                      ? t('artistDetail.sortYearDesc')
                      : t('artistDetail.sortYearAsc')}
                  </button>
                )}
              </div>
              {albums.length > 0 ? (
                groupedAlbums.length === 1 ? (
                  <VirtualCardGrid
                    items={groupedAlbums[0][1]}
                    itemKey={(a, i) => `${a.id}-${i}`}
                    rowVariant="album"
                    disableVirtualization={perfFlags.disableMainstageVirtualLists}
                    layoutSignal={groupedAlbums[0][1].length}
                    wrapClassName="album-grid-wrap album-grid-wrap--artist"
                    warmGridCovers={albumGridWarmCovers()}
                    renderItem={a => (
                      <AlbumCard
                        album={a}
                        linkQuery={losslessOnly ? LOSSLESS_MODE_QUERY : undefined}
                      />
                    )}
                  />
                ) : groupedAlbums.map(([label, group]) => (
                  <div key={label} className="artist-release-group">
                    <div className="artist-release-group__header">
                      <h3>{label}</h3>
                      <span className="artist-release-group__count">{group.length}</span>
                    </div>
                    <VirtualCardGrid
                      items={group}
                      itemKey={(a, i) => `${a.id}-${i}`}
                      rowVariant="album"
                      disableVirtualization={perfFlags.disableMainstageVirtualLists}
                      layoutSignal={group.length}
                      wrapClassName="album-grid-wrap album-grid-wrap--artist"
                      warmGridCovers={albumGridWarmCovers()}
                      renderItem={a => (
                      <AlbumCard
                        album={a}
                        linkQuery={losslessOnly ? LOSSLESS_MODE_QUERY : undefined}
                      />
                    )}
                    />
                  </div>
                ))
              ) : (
                <p style={{ color: 'var(--text-muted)' }}>{t('artistDetail.noAlbums')}</p>
              )}
            </Fragment>
          );

          case 'featured': return (
            <Fragment key="featured">
              <h2 className="section-title" style={{ marginTop: sectionMt('featured'), marginBottom: '1rem' }}>
                {t('artistDetail.featuredOn')}
              </h2>
              {featuredLoading ? (
                <div className="album-grid-wrap">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} style={{ flex: '0 0 clamp(140px, 15vw, 180px)', borderRadius: '8px', background: 'var(--bg-card)', aspectRatio: '1', opacity: 0.5 }} />
                  ))}
                </div>
              ) : (
                <VirtualCardGrid
                  items={featuredAlbums}
                  itemKey={(a, i) => `${a.id}-${i}`}
                  rowVariant="album"
                  disableVirtualization={perfFlags.disableMainstageVirtualLists}
                  layoutSignal={featuredAlbums.length}
                  wrapClassName="album-grid-wrap album-grid-wrap--artist"
                  wrapStyle={{ animation: 'fadeIn 0.3s ease' }}
                  warmGridCovers={albumGridWarmCovers()}
                  renderItem={a => <AlbumCard album={a} />}
                />
              )}
            </Fragment>
          );

          default: return null;
        }
      })}
    </div>
  );
}
