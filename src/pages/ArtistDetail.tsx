import { uploadArtistImage } from '../api/subsonicPlaylists';
import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonicStreamUrl';
import { setRating, star, unstar } from '../api/subsonicStarRating';
import { getAlbum } from '../api/subsonicLibrary';
import type { SubsonicArtist, SubsonicAlbum, SubsonicSong, SubsonicArtistInfo } from '../api/subsonicTypes';
import { songToTrack } from '../utils/playback/songToTrack';
import { useEffect, useState, useRef, Fragment, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import AlbumCard from '../components/AlbumCard';
import CachedImage from '../components/CachedImage';
import CoverLightbox from '../components/CoverLightbox';
import { ArrowLeft, Users, ExternalLink, Heart, Play, Square, Shuffle, Radio, HardDriveDownload, Check, Camera, Loader2, ChevronDown, ChevronRight, ChevronUp, Share2, AudioLines } from 'lucide-react';
import { useIsMobile } from '../hooks/useIsMobile';
import { useOrbitSongRowBehavior } from '../hooks/useOrbitSongRowBehavior';
import { open } from '@tauri-apps/plugin-shell';
import { usePlayerStore } from '../store/playerStore';
import { usePreviewStore } from '../store/previewStore';
import { useOfflineStore } from '../store/offlineStore';
import { useOfflineJobStore } from '../store/offlineJobStore';
import { useAuthStore } from '../store/authStore';
import { useTranslation } from 'react-i18next';
import { lastfmIsConfigured } from '../api/lastfm';
import LastfmIcon from '../components/LastfmIcon';
import { invalidateCoverArt } from '../utils/imageCache';
import { showToast } from '../utils/ui/toast';
import { copyEntityShareLink } from '../utils/share/copyEntityShareLink';
import { extractCoverColors } from '../utils/ui/dynamicColors';
import StarRating from '../components/StarRating';
import { useArtistLayoutStore, type ArtistSectionId } from '../store/artistLayoutStore';

import { sanitizeHtml } from '../utils/sanitizeHtml';
import { useArtistDetailData } from '../hooks/useArtistDetailData';
import { useArtistSimilarArtists } from '../hooks/useArtistSimilarArtists';
import {
  runArtistDetailPlayAll, runArtistDetailShuffle, runArtistDetailStartRadio,
} from '../utils/componentHelpers/runArtistDetailPlay';
import {
  runArtistEntityRating, runArtistToggleStar, runArtistShare, runArtistImageUpload,
} from '../utils/componentHelpers/runArtistDetailActions';
import ArtistDetailHero from '../components/artistDetail/ArtistDetailHero';
import ArtistDetailTopTracks from '../components/artistDetail/ArtistDetailTopTracks';
import ArtistDetailSimilarArtists from '../components/artistDetail/ArtistDetailSimilarArtists';


export default function ArtistDetail() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const {
    artist, setArtist, albums, topSongs, info, featuredAlbums,
    loading, artistInfoLoading, featuredLoading,
    isStarred, setIsStarred,
  } = useArtistDetailData(id);
  const [radioLoading, setRadioLoading] = useState(false);
  const [playAllLoading, setPlayAllLoading] = useState(false);
  const [openedLink, setOpenedLink] = useState<string | null>(null);
  const { similarArtists, similarLoading } = useArtistSimilarArtists(artist, info, artistInfoLoading);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [bioExpanded, setBioExpanded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [similarCollapsed, setSimilarCollapsed] = useState(true);
  const isMobile = useIsMobile();
  const [coverRevision, setCoverRevision] = useState(0);
  const [avatarGlow, setAvatarGlow] = useState('');
  /** True after header CachedImage onError — avoid `display:none` on the img (breaks recovery). */
  const [headerCoverFailed, setHeaderCoverFailed] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const playTrack = usePlayerStore(state => state.playTrack);
  const enqueue = usePlayerStore(state => state.enqueue);
  const { orbitActive, queueHint, addTrackToOrbit } = useOrbitSongRowBehavior();
  const clearQueue = usePlayerStore(state => state.clearQueue);
  const openContextMenu = usePlayerStore(state => state.openContextMenu);
  const currentTrack = usePlayerStore(state => state.currentTrack);
  const isPlaying = usePlayerStore(state => state.isPlaying);
  const previewingId = usePreviewStore(s => s.previewingId);
  const previewAudioStarted = usePreviewStore(s => s.audioStarted);
  const downloadArtist = useOfflineStore(s => s.downloadArtist);
  const bulkProgress = useOfflineJobStore(s => s.bulkProgress);
  const activeServerId = useAuthStore(s => s.activeServerId) ?? '';
  const audiomuseNavidromeEnabled = useAuthStore(
    s => !!(s.activeServerId && s.audiomuseNavidromeByServer[s.activeServerId]),
  );
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  // MUST stay above the loading / !artist early returns or React's hook
  // call order will mismatch between renders.
  const sectionConfig = useArtistLayoutStore(s => s.sections);
  const entityRatingSupportByServer = useAuthStore(s => s.entityRatingSupportByServer);
  const setEntityRatingSupport = useAuthStore(s => s.setEntityRatingSupport);
  const artistEntityRatingSupport = entityRatingSupportByServer[activeServerId] ?? 'unknown';

  const [artistEntityRating, setArtistEntityRating] = useState(0);

  useEffect(() => {
    setAvatarGlow('');
  }, [id]);

  useEffect(() => {
    if (!id) return;
    if (artist && artist.id === id) setArtistEntityRating(artist.userRating ?? 0);
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

  const handlePlayAll = () => runArtistDetailPlayAll({ albums, setPlayAllLoading, playTrack });
  const handleShuffle = () => runArtistDetailShuffle({ albums, setPlayAllLoading, playTrack });
  const handleStartRadio = () => {
    if (!artist) return;
    return runArtistDetailStartRadio({ artist, t, setRadioLoading, playTrack, enqueue });
  };

  const handleShareArtist = () => {
    if (!id || !artist) return;
    return runArtistShare({ artist, t });
  };

  const playTopSongWithContinuation = async (startIndex: number) => {
    if (!artist || albums.length === 0) return;
    setPlayAllLoading(true);
    try {
      // Get all artist tracks ordered by album and track number
      const results = await Promise.all(albums.map(a => getAlbum(a.id)));
      const sorted = [...results].sort((a, b) => (a.album.year ?? 0) - (b.album.year ?? 0));
      const allTracks = sorted.flatMap(r => [...r.songs].sort((a, b) => (a.track ?? 0) - (b.track ?? 0))).map(songToTrack);

      // Top songs from clicked index onward
      const topTracksFromIndex = topSongs.slice(startIndex).map(songToTrack);

      // Track IDs for deduplication
      const topSongIds = new Set(topSongs.map(s => s.id));

      // Filter remaining tracks to exclude top songs (prevent duplicates)
      const remainingTracks = allTracks.filter(tr => !topSongIds.has(tr.id));

      // Build queue: remaining top songs + rest of artist catalog
      const queue = [...topTracksFromIndex, ...remainingTracks];
      
      if (queue.length > 0) {
        playTrack(queue[0], queue);
      }
    } finally {
      setPlayAllLoading(false);
    }
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => runArtistImageUpload({
    e, artist, t, setUploading, setCoverRevision,
  });

  // Cover URLs — must run every render (before early returns) or hook order breaks.
  const coverId = artist ? (artist.coverArt || artist.id) : '';
  const artistCover300Src = useMemo(
    () => (coverId ? buildCoverArtUrl(coverId, 300) : ''),
    [coverId],
  );
  const artistCover300Key = useMemo(
    () => (coverId ? coverArtCacheKey(coverId, 300) : ''),
    [coverId],
  );
  const artistCover2000Src = useMemo(
    () => (coverId ? buildCoverArtUrl(coverId, 2000) : ''),
    [coverId],
  );
  const artistCover80FallbackSrc = useMemo(
    () => (coverId ? buildCoverArtUrl(coverId, 80) : ''),
    [coverId],
  );

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

    if (groups.size === 1 && groups.has(defaultKey)) {
      return [[translateType(defaultKey), albums] as const];
    }

    const sortKey = (key: string) => {
      const idx = RELEASE_TYPE_ORDER.indexOf(key.split(' · ')[0]);
      return idx >= 0 ? idx : RELEASE_TYPE_ORDER.length;
    };

    return [...groups.entries()]
      .sort((a, b) => sortKey(a[0]) - sortKey(b[0]) || a[0].localeCompare(b[0]))
      .map(([key, group]) => [key.split(' · ').map(translateType).join(' · '), group] as const);
  }, [albums, t]);

  useEffect(() => {
    setHeaderCoverFailed(false);
  }, [coverId, coverRevision, id]);

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

  const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(artist.name)}`;

  const serverSimilarArtists: SubsonicArtist[] = (info?.similarArtist ?? []).map(sa => ({
    id: sa.id,
    name: sa.name,
    albumCount: sa.albumCount,
  }));
  const showAudiomuseSimilar = audiomuseNavidromeEnabled && serverSimilarArtists.length > 0;
  const showLastfmSimilar =
    lastfmIsConfigured() &&
    (!audiomuseNavidromeEnabled || serverSimilarArtists.length === 0) &&
    (similarLoading || similarArtists.length > 0);
  const showSimilarSection = showAudiomuseSimilar || showLastfmSimilar;

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
        artistCover300Src={artistCover300Src}
        artistCover300Key={artistCover300Key}
        artistCover2000Src={artistCover2000Src}
        coverRevision={coverRevision}
        headerCoverFailed={headerCoverFailed}
        setHeaderCoverFailed={setHeaderCoverFailed}
        avatarGlow={avatarGlow}
        setAvatarGlow={setAvatarGlow}
        lightboxOpen={lightboxOpen}
        setLightboxOpen={setLightboxOpen}
      />

      {/* User-reorderable sections — order + visibility configured in Settings.
       * Each case renders the same JSX it did pre-refactor; only `marginTop`
       * (now derived from the actual render order) and the outer wrapper changed. */}
      {renderableSectionIds.map(sectionId => {
        switch (sectionId) {
          case 'bio': return (
            <div
              key="bio"
              className="np-info-card artist-bio-card"
              style={{ marginTop: sectionMt('bio') }}
            >
              <div className="np-card-header">
                <h3 className="np-card-title">{t('nowPlaying.aboutArtist')}</h3>
              </div>
              <div className="np-artist-bio-row">
                {(info?.largeImageUrl || coverId) && (
                  <img
                    src={info?.largeImageUrl || artistCover80FallbackSrc}
                    alt={artist.name}
                    className="np-artist-thumb"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                )}
                <div className="np-bio-wrap">
                  <div
                    className={`np-bio-text${bioExpanded ? ' expanded' : ''}`}
                    dangerouslySetInnerHTML={{ __html: sanitizeHtml(info!.biography!) }}
                  />
                  <button className="np-bio-toggle" onClick={() => setBioExpanded(v => !v)}>
                    {bioExpanded ? t('nowPlaying.showLess') : t('nowPlaying.readMore')}
                  </button>
                </div>
              </div>
            </div>
          );

          case 'topTracks': return (
            <ArtistDetailTopTracks
              key="topTracks"
              topSongs={topSongs}
              marginTop={sectionMt('topTracks')}
              playTopSongWithContinuation={playTopSongWithContinuation}
            />
          );

          case 'similar': return (
            <ArtistDetailSimilarArtists
              key="similar"
              marginTop={sectionMt('similar')}
              showAudiomuseSimilar={showAudiomuseSimilar}
              showLastfmSimilar={showLastfmSimilar}
              similarLoading={similarLoading}
              similarArtists={similarArtists}
              serverSimilarArtists={serverSimilarArtists}
              similarCollapsed={similarCollapsed}
              setSimilarCollapsed={setSimilarCollapsed}
            />
          );

          case 'albums': return (
            <Fragment key="albums">
              <h2 className="section-title" style={{ marginTop: sectionMt('albums'), marginBottom: '1rem' }}>
                {t('artistDetail.albumsBy', { name: artist.name })}
              </h2>
              {albums.length > 0 ? (
                groupedAlbums.length === 1 ? (
                  <div className="album-grid-wrap album-grid-wrap--artist">
                    {albums.map((a, i) => <AlbumCard key={`${a.id}-${i}`} album={a} />)}
                  </div>
                ) : groupedAlbums.map(([label, group]) => (
                  <div key={label} className="artist-release-group">
                    <div className="artist-release-group__header">
                      <h3>{label}</h3>
                      <span className="artist-release-group__count">{group.length}</span>
                    </div>
                    <div className="album-grid-wrap album-grid-wrap--artist">
                      {group.map((a, i) => <AlbumCard key={`${a.id}-${i}`} album={a} />)}
                    </div>
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
                <div className="album-grid-wrap album-grid-wrap--artist" style={{ animation: 'fadeIn 0.3s ease' }}>
                  {featuredAlbums.map((a, i) => <AlbumCard key={`${a.id}-${i}`} album={a} />)}
                </div>
              )}
            </Fragment>
          );

          default: return null;
        }
      })}
    </div>
  );
}
