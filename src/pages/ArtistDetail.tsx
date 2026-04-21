import { useEffect, useState, useRef, Fragment } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getArtist, getArtistInfo, getTopSongs, getSimilarSongs2, getAlbum, search, setRating, SubsonicArtist, SubsonicAlbum, SubsonicSong, SubsonicArtistInfo, buildCoverArtUrl, coverArtCacheKey, star, unstar, uploadArtistImage } from '../api/subsonic';
import AlbumCard from '../components/AlbumCard';
import CachedImage from '../components/CachedImage';
import CoverLightbox from '../components/CoverLightbox';
import { ArrowLeft, Users, ExternalLink, Heart, Play, Shuffle, Radio, HardDriveDownload, Check, Camera, Loader2, ChevronDown, ChevronUp, Share2 } from 'lucide-react';
import { useIsMobile } from '../hooks/useIsMobile';
import { open } from '@tauri-apps/plugin-shell';
import { usePlayerStore, songToTrack } from '../store/playerStore';
import { useOfflineStore } from '../store/offlineStore';
import { useOfflineJobStore } from '../store/offlineJobStore';
import { useAuthStore } from '../store/authStore';
import { useTranslation } from 'react-i18next';
import { lastfmGetSimilarArtists, lastfmIsConfigured } from '../api/lastfm';
import LastfmIcon from '../components/LastfmIcon';
import { invalidateCoverArt } from '../utils/imageCache';
import { showToast } from '../utils/toast';
import { copyEntityShareLink } from '../utils/copyEntityShareLink';
import { extractCoverColors } from '../utils/dynamicColors';
import StarRating from '../components/StarRating';
import { useArtistLayoutStore, type ArtistSectionId } from '../store/artistLayoutStore';

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Strip dangerous tags/attributes from server-provided HTML */
function sanitizeHtml(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, form, input, button, select, base, meta, link').forEach(el => el.remove());
  doc.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      const name = attr.name.toLowerCase();
      const val = attr.value.toLowerCase().trim();
      if (name.startsWith('on') || (name === 'href' && (val.startsWith('javascript:') || val.startsWith('data:'))) || (name === 'src' && (val.startsWith('javascript:') || val.startsWith('data:')))) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return doc.body.innerHTML;
}


export default function ArtistDetail() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [artist, setArtist] = useState<SubsonicArtist | null>(null);
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [featuredAlbums, setFeaturedAlbums] = useState<SubsonicAlbum[]>([]);
  const [topSongs, setTopSongs] = useState<SubsonicSong[]>([]);
  const [info, setInfo] = useState<SubsonicArtistInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [radioLoading, setRadioLoading] = useState(false);
  const [playAllLoading, setPlayAllLoading] = useState(false);
  const [isStarred, setIsStarred] = useState(false);
  const [openedLink, setOpenedLink] = useState<string | null>(null);
  const [similarArtists, setSimilarArtists] = useState<SubsonicArtist[]>([]);
  const [similarLoading, setSimilarLoading] = useState(false);
  const [artistInfoLoading, setArtistInfoLoading] = useState(false);
  const [featuredLoading, setFeaturedLoading] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [bioExpanded, setBioExpanded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [similarCollapsed, setSimilarCollapsed] = useState(true);
  const isMobile = useIsMobile();
  const [coverRevision, setCoverRevision] = useState(0);
  const [avatarGlow, setAvatarGlow] = useState('');
  const imageInputRef = useRef<HTMLInputElement>(null);

  const playTrack = usePlayerStore(state => state.playTrack);
  const enqueue = usePlayerStore(state => state.enqueue);
  const clearQueue = usePlayerStore(state => state.clearQueue);
  const openContextMenu = usePlayerStore(state => state.openContextMenu);
  const currentTrack = usePlayerStore(state => state.currentTrack);
  const isPlaying = usePlayerStore(state => state.isPlaying);
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
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setInfo(null);
    setTopSongs([]);
    setFeaturedAlbums([]);
    setAvatarGlow('');
    getArtist(id).then(artistData => {
      if (cancelled) return;
      setArtist(artistData.artist);
      setAlbums(artistData.albums);
      setIsStarred(!!artistData.artist.starred);
      // Render the page immediately from local data
      setLoading(false);

      getTopSongs(artistData.artist.name).then(songsData => {
        if (!cancelled) setTopSongs(songsData ?? []);
      }).catch(() => {});
    }).catch(err => {
      if (!cancelled) { console.error(err); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setArtistInfoLoading(true);
    getArtistInfo(id, { similarArtistCount: audiomuseNavidromeEnabled ? 24 : undefined })
      .then(artistInfo => {
        if (!cancelled) setInfo(artistInfo ?? null);
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      })
      .finally(() => {
        if (!cancelled) setArtistInfoLoading(false);
      });
    return () => { cancelled = true; };
  }, [id, audiomuseNavidromeEnabled]);

  useEffect(() => {
    if (!id) return;
    if (artist && artist.id === id) setArtistEntityRating(artist.userRating ?? 0);
  }, [id, artist?.id, artist?.userRating]);

  const handleArtistEntityRating = async (rating: number) => {
    if (!artist || artist.id !== id) return;
    const artistId = artist.id;
    const ratingAtStart = artist.userRating ?? 0;

    setArtistEntityRating(rating);

    if (artistEntityRatingSupport !== 'full') return;

    try {
      await setRating(artistId, rating);
      setArtist(a => (a && a.id === artistId ? { ...a, userRating: rating } : a));
    } catch (err) {
      setArtistEntityRating(ratingAtStart);
      setEntityRatingSupport(activeServerId, 'track_only');
      showToast(
        typeof err === 'string' ? err : err instanceof Error ? err.message : t('entityRating.saveFailed'),
        4500,
        'error',
      );
    }
  };

  // "Also Featured On" — loaded in background after main content renders
  useEffect(() => {
    if (!id || !artist) return;
    const ownAlbumIds = new Set(albums.map(a => a.id));
    setFeaturedLoading(true);
    search(artist.name, { songCount: 500, artistCount: 0, albumCount: 0 })
      .catch(() => ({ songs: [], albums: [], artists: [] }))
      .then(searchResults => {
        const featuredSongs = (searchResults.songs ?? []).filter(
          song => song.artistId === id && !ownAlbumIds.has(song.albumId)
        );
        const albumMap = new Map<string, SubsonicAlbum>();
        featuredSongs.forEach(song => {
          if (!albumMap.has(song.albumId)) {
            albumMap.set(song.albumId, {
              id: song.albumId,
              name: song.album,
              artist: song.albumArtist ?? '',
              artistId: '',
              coverArt: song.coverArt,
              songCount: 1,
              duration: song.duration,
              year: song.year,
            });
          } else {
            const a = albumMap.get(song.albumId)!;
            a.songCount++;
            a.duration += song.duration;
          }
        });
        setFeaturedAlbums([...albumMap.values()]);
        setFeaturedLoading(false);
      });
  }, [artist?.id, musicLibraryFilterVersion]);

  useEffect(() => {
    if (!artist || audiomuseNavidromeEnabled || !lastfmIsConfigured()) return;
    setSimilarArtists([]);
    setSimilarLoading(true);
    lastfmGetSimilarArtists(artist.name).then(async names => {
      if (names.length === 0) { setSimilarLoading(false); return; }
      const results = await Promise.all(
        names.slice(0, 30).map(name =>
          search(name, { artistCount: 3, albumCount: 0, songCount: 0 }).catch(() => ({ artists: [], albums: [], songs: [] }))
        )
      );
      const seen = new Set<string>([artist.id]);
      const found: SubsonicArtist[] = [];
      for (let i = 0; i < results.length; i++) {
        const targetName = names[i].toLowerCase();
        const match = results[i].artists.find(a => a.name.toLowerCase() === targetName);
        if (match && !seen.has(match.id)) {
          seen.add(match.id);
          found.push(match);
        }
      }
      setSimilarArtists(found);
      setSimilarLoading(false);
    }).catch(() => setSimilarLoading(false));
  }, [artist?.id, musicLibraryFilterVersion, audiomuseNavidromeEnabled]);

  /** When AudioMuse is on but the server returns no similar artists, fall back to Last.fm (if configured). */
  useEffect(() => {
    if (!artist || !audiomuseNavidromeEnabled || !lastfmIsConfigured()) return;
    if (artistInfoLoading) return;
    if ((info?.similarArtist?.length ?? 0) > 0) return;

    setSimilarArtists([]);
    setSimilarLoading(true);
    lastfmGetSimilarArtists(artist.name).then(async names => {
      if (names.length === 0) { setSimilarLoading(false); return; }
      const results = await Promise.all(
        names.slice(0, 30).map(name =>
          search(name, { artistCount: 3, albumCount: 0, songCount: 0 }).catch(() => ({ artists: [], albums: [], songs: [] }))
        )
      );
      const seen = new Set<string>([artist.id]);
      const found: SubsonicArtist[] = [];
      for (let i = 0; i < results.length; i++) {
        const targetName = names[i].toLowerCase();
        const match = results[i].artists.find(a => a.name.toLowerCase() === targetName);
        if (match && !seen.has(match.id)) {
          seen.add(match.id);
          found.push(match);
        }
      }
      setSimilarArtists(found);
      setSimilarLoading(false);
    }).catch(() => setSimilarLoading(false));
  }, [
    artist?.id,
    artist?.name,
    musicLibraryFilterVersion,
    audiomuseNavidromeEnabled,
    artistInfoLoading,
    info?.similarArtist?.length,
  ]);

  useEffect(() => {
    if (!audiomuseNavidromeEnabled) return;
    if ((info?.similarArtist?.length ?? 0) > 0) {
      setSimilarArtists([]);
      setSimilarLoading(false);
    }
  }, [id, audiomuseNavidromeEnabled, info?.similarArtist?.length]);

  const openLink = (url: string, key: string) => {
    open(url);
    setOpenedLink(key);
    setTimeout(() => setOpenedLink(null), 2500);
  };

  const toggleStar = async () => {
    if (!artist) return;
    const currentlyStarred = isStarred;
    setIsStarred(!currentlyStarred);
    try {
      if (currentlyStarred) await unstar(artist.id, 'artist');
      else await star(artist.id, 'artist');
    } catch (e) {
      console.error('Failed to toggle star', e);
      setIsStarred(currentlyStarred);
    }
  };

  const fetchAllTracks = async () => {
    const results = await Promise.all(albums.map(a => getAlbum(a.id)));
    const sorted = [...results].sort((a, b) => (a.album.year ?? 0) - (b.album.year ?? 0));
    return sorted.flatMap(r => [...r.songs].sort((a, b) => (a.track ?? 0) - (b.track ?? 0))).map(songToTrack);
  };

  const handlePlayAll = async () => {
    if (albums.length === 0) return;
    setPlayAllLoading(true);
    try {
      const tracks = await fetchAllTracks();
      if (tracks.length > 0) playTrack(tracks[0], tracks);
    } finally {
      setPlayAllLoading(false);
    }
  };

  const handleShuffle = async () => {
    if (albums.length === 0) return;
    setPlayAllLoading(true);
    try {
      const tracks = await fetchAllTracks();
      if (tracks.length > 0) {
        const shuffled = [...tracks].sort(() => Math.random() - 0.5);
        playTrack(shuffled[0], shuffled);
      }
    } finally {
      setPlayAllLoading(false);
    }
  };

  const handleStartRadio = async () => {
    if (!artist) return;
    setRadioLoading(true);
    try {
      // Fire both fetches in parallel
      const topPromise = getTopSongs(artist.name);
      const similarPromise = getSimilarSongs2(artist.id, 50);

      // Start playing as soon as top songs arrive
      const top = await topPromise;
      if (top.length > 0) {
        const firstTrack = songToTrack(top[0]);
        playTrack(firstTrack, [firstTrack]);
        setRadioLoading(false);
        // Enqueue remaining tracks when similar songs arrive
        const similar = await similarPromise;
        const remaining = [...top.slice(1), ...similar].map(songToTrack);
        if (remaining.length > 0) enqueue(remaining);
      } else {
        // No top songs — fall back to similar
        const similar = await similarPromise;
        if (similar.length > 0) {
          const tracks = similar.map(songToTrack);
          playTrack(tracks[0], tracks);
        } else {
          alert(t('artistDetail.noRadio'));
        }
        setRadioLoading(false);
      }
    } catch (e) {
      console.error('Radio start failed', e);
      setRadioLoading(false);
    }
  };

  const handleShareArtist = async () => {
    if (!id || !artist) return;
    try {
      const ok = await copyEntityShareLink('artist', artist.id);
      if (ok) showToast(t('contextMenu.shareCopied'));
      else showToast(t('contextMenu.shareCopyFailed'), 4000, 'error');
    } catch {
      showToast(t('contextMenu.shareCopyFailed'), 4000, 'error');
    }
  };

  const playTopSongWithContinuation = async (startIndex: number) => {
    if (!artist || albums.length === 0) return;
    setPlayAllLoading(true);
    try {
      // Get all artist tracks ordered by album and track number
      const allTracks = await fetchAllTracks();

      // Top songs from clicked index onward
      const topTracksFromIndex = topSongs.slice(startIndex).map(songToTrack);

      // Track IDs for deduplication
      const topSongIds = new Set(topSongs.map(s => s.id));

      // Filter remaining tracks to exclude top songs (prevent duplicates)
      const remainingTracks = allTracks.filter(t => !topSongIds.has(t.id));

      // Build queue: remaining top songs + rest of artist catalog
      const queue = [...topTracksFromIndex, ...remainingTracks];
      
      if (queue.length > 0) {
        playTrack(queue[0], queue);
      }
    } finally {
      setPlayAllLoading(false);
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !artist) return;
    setUploading(true);
    try {
      await uploadArtistImage(artist.id, file);
      const coverId = artist.coverArt || artist.id;
      await invalidateCoverArt(coverId);
      // Also invalidate with bare artist.id in case coverArt differs
      if (artist.coverArt && artist.coverArt !== artist.id) {
        await invalidateCoverArt(artist.id);
      }
      setCoverRevision(r => r + 1);
      showToast(t('artistDetail.uploadImage'));
    } catch (err) {
      showToast(
        typeof err === 'string' ? err : err instanceof Error ? err.message : t('artistDetail.uploadImageError'),
        4000,
        'error',
      );
    } finally {
      setUploading(false);
    }
  };

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

  const coverId = artist.coverArt || artist.id;
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
      <button
        className="btn btn-ghost"
        onClick={() => navigate(-1)}
        style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
      >
        <ArrowLeft size={16} /> <span>{t('artistDetail.back')}</span>
      </button>

      {lightboxOpen && (
        <CoverLightbox
          src={buildCoverArtUrl(coverId, 2000)}
          alt={artist.name}
          onClose={() => setLightboxOpen(false)}
        />
      )}

      <div className="artist-detail-header">
        <div
          className="artist-detail-avatar"
          style={{
            position: 'relative',
            boxShadow: avatarGlow ? `0 0 36px 8px ${avatarGlow.replace('rgb(', 'rgba(').replace(')', ', 0.55)')}` : undefined,
            transition: 'box-shadow 0.6s ease',
          }}
        >
          {coverId ? (
            <button
              className="artist-detail-avatar-btn"
              onClick={() => setLightboxOpen(true)}
              aria-label={`${artist.name} Bild vergrößern`}
            >
              <CachedImage
                key={coverRevision}
                src={buildCoverArtUrl(coverId, 300)}
                cacheKey={coverArtCacheKey(coverId, 300)}
                alt={artist.name}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                onLoad={e => extractCoverColors(e.currentTarget.src).then(({ accent }) => { if (accent) setAvatarGlow(accent); })}
                onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            </button>
          ) : (
            <Users size={64} color="var(--text-muted)" />
          )}
          {/* Upload overlay */}
          <div
            className="artist-avatar-upload-overlay"
            onClick={e => { e.stopPropagation(); imageInputRef.current?.click(); }}
          >
            {uploading
              ? <Loader2 size={22} className="spin-slow" />
              : <Camera size={22} />}
          </div>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleImageUpload}
          />
        </div>

        <div className="artist-detail-meta">
          <h1 className="page-title" style={{ fontSize: '3rem', marginBottom: '0.25rem' }}>
            {artist.name}
          </h1>
          <div style={{ color: 'var(--text-secondary)', fontSize: '1rem', marginBottom: '1rem' }}>
            {t('artistDetail.albumCount_other', { count: artist.albumCount ?? 0 })}
          </div>

          <div className="artist-detail-entity-rating">
            <span className="artist-detail-entity-rating-label">{t('entityRating.artistShort')}</span>
            <StarRating
              value={artistEntityRating}
              onChange={handleArtistEntityRating}
              disabled={artistEntityRatingSupport === 'track_only'}
              labelKey="entityRating.artistAriaLabel"
            />
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {(info?.lastFmUrl || artist.name) && (
              <div className="artist-detail-links">
                {info?.lastFmUrl && (
                  <button className="artist-ext-link" onClick={() => openLink(info.lastFmUrl!, 'lastfm')}>
                    <LastfmIcon size={14} />
                    {openedLink === 'lastfm' ? t('artistDetail.openedInBrowser') : 'Last.fm'}
                  </button>
                )}
                <button className="artist-ext-link" onClick={() => openLink(wikiUrl, 'wiki')}>
                  <ExternalLink size={14} />
                  {openedLink === 'wiki' ? t('artistDetail.openedInBrowser') : 'Wikipedia'}
                </button>
              </div>
            )}

            <button
              className="artist-ext-link"
              onClick={toggleStar}
              data-tooltip={isStarred ? t('artistDetail.favoriteRemove') : t('artistDetail.favoriteAdd')}
              style={{ color: isStarred ? 'var(--accent)' : 'inherit', border: isStarred ? '1px solid var(--accent)' : undefined }}
            >
              <Heart size={14} fill={isStarred ? "currentColor" : "none"} />
              {t('artistDetail.favorite')}
            </button>
          </div>

          <div style={{ display: 'flex', gap: '8px', marginTop: '1.5rem', flexWrap: 'wrap' }}>
            {albums.length > 0 && (
              <>
                <button className="btn btn-primary" onClick={handlePlayAll} disabled={playAllLoading}>
                  {playAllLoading ? <div className="spinner" style={{ width: 16, height: 16, borderTopColor: 'currentColor' }} /> : <Play size={16} />}
                  {t('artistDetail.playAll')}
                </button>
                <button
                  className="btn btn-surface"
                  onClick={handleShuffle}
                  disabled={playAllLoading}
                  data-tooltip={isMobile ? t('artistDetail.shuffle') : undefined}
                >
                  {playAllLoading ? <div className="spinner" style={{ width: 16, height: 16, borderTopColor: 'currentColor' }} /> : <Shuffle size={16} />}
                  {!isMobile && t('artistDetail.shuffle')}
                </button>
              </>
            )}
            <button
              className="btn btn-surface"
              onClick={handleStartRadio}
              disabled={radioLoading}
              data-tooltip={isMobile ? t('artistDetail.radio') : undefined}
            >
              {radioLoading ? <div className="spinner" style={{ width: 16, height: 16, borderTopColor: 'currentColor' }} /> : <Radio size={16} />}
              {!isMobile && (radioLoading ? t('artistDetail.loading') : t('artistDetail.radio'))}
            </button>
            {id && artist && (
              <button
                type="button"
                className="btn btn-surface"
                onClick={handleShareArtist}
                aria-label={t('artistDetail.shareArtist')}
                data-tooltip={t('artistDetail.shareArtist')}
              >
                <Share2 size={16} />
              </button>
            )}
            {albums.length > 0 && (() => {
              const progress = id ? bulkProgress[id] : undefined;
              const isDone = progress && progress.done === progress.total;
              const isDownloading = progress && !isDone;
              return (
                <button
                  className="btn btn-surface"
                  disabled={!!isDownloading}
                  onClick={() => { if (id && artist) downloadArtist(id, artist.name, activeServerId); }}
                  data-tooltip={isDownloading
                    ? t('artistDetail.offlineDownloading', { done: progress.done, total: progress.total })
                    : isDone ? t('artistDetail.offlineCached') : t('artistDetail.cacheOffline')}
                >
                  {isDownloading
                    ? <div className="spinner" style={{ width: 16, height: 16, borderTopColor: 'currentColor' }} />
                    : isDone ? <Check size={16} /> : <HardDriveDownload size={16} />}
                  {!isMobile && (isDownloading
                    ? t('artistDetail.offlineDownloading', { done: progress.done, total: progress.total })
                    : isDone ? t('artistDetail.offlineCached') : t('artistDetail.cacheOffline'))}
                </button>
              );
            })()}
          </div>
        </div>
      </div>

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
                    src={info?.largeImageUrl || buildCoverArtUrl(coverId, 80)}
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
            <Fragment key="topTracks">
              <h2 className="section-title" style={{ marginTop: sectionMt('topTracks'), marginBottom: '1rem' }}>
                {t('artistDetail.topTracks')}
              </h2>
          <div className="tracklist" style={{ padding: 0, marginBottom: '2rem' }}>
            <div className="tracklist-header" style={{ gridTemplateColumns: '60px minmax(150px, 1fr) minmax(100px, 1fr) 65px' }}>
              <div style={{ textAlign: 'center' }}>#</div>
              <div>{t('artistDetail.trackTitle')}</div>
              <div>{t('artistDetail.trackAlbum')}</div>
              <div style={{ textAlign: 'right' }}>{t('artistDetail.trackDuration')}</div>
            </div>
             {topSongs.map((song, idx) => {
                   const track = songToTrack(song);
                   return (
                     <div
                       key={song.id}
                       className="track-row"
                       style={{ gridTemplateColumns: '60px minmax(150px, 1fr) minmax(100px, 1fr) 65px' }}
                       onClick={e => {
                         if ((e.target as HTMLElement).closest('button, a, input')) return;
                         playTopSongWithContinuation(idx);
                       }}
                       onContextMenu={(e) => {
                         e.preventDefault();
                         openContextMenu(e.clientX, e.clientY, track, 'song');
                       }}
                     >
                <div className={`track-num${currentTrack?.id === song.id ? ' track-num-active' : ''}`} style={{ cursor: 'pointer' }} onClick={e => { e.stopPropagation(); playTopSongWithContinuation(idx); }}>
                  {currentTrack?.id === song.id && isPlaying && <span className="track-num-eq"><div className="eq-bars"><span className="eq-bar" /><span className="eq-bar" /><span className="eq-bar" /></div></span>}
                  <span className="track-num-play"><Play size={13} fill="currentColor" /></span>
                  <span className="track-num-number">{idx + 1}</span>
                </div>
                <div className="track-info" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  {song.coverArt && (
                    <CachedImage
                      src={buildCoverArtUrl(song.coverArt, 64)}
                      cacheKey={coverArtCacheKey(song.coverArt, 64)}
                      alt={song.album}
                      style={{ width: '32px', height: '32px', borderRadius: '4px', objectFit: 'cover', flexShrink: 0 }}
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                    />
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <div className="track-title">{song.title}</div>
                  </div>
                </div>
                <div className="track-album truncate" style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>
                  {song.album}
                </div>
                <div className="track-duration" style={{ textAlign: 'right' }}>
                {formatDuration(song.duration)}
                 </div>
               </div>
               );
             })}
           </div>
            </Fragment>
          );

          case 'similar': return (
            <Fragment key="similar">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: sectionMt('similar'), marginBottom: '1rem' }}>
                <h2 className="section-title" style={{ margin: 0 }}>
                  {t('artistDetail.similarArtists')}
                </h2>
                {isMobile && (() => {
                  const list = showAudiomuseSimilar ? serverSimilarArtists : similarArtists;
                  return list.length > 5 ? (
                    <button className="btn btn-ghost" style={{ fontSize: 12, padding: '2px 8px' }} onClick={() => setSimilarCollapsed(v => !v)}>
                      {similarCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                      {similarCollapsed ? t('nowPlaying.readMore') : t('nowPlaying.showLess')}
                    </button>
                  ) : null;
                })()}
              </div>
              {showLastfmSimilar && similarLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                  <div className="spinner" style={{ width: 16, height: 16, borderTopColor: 'currentColor' }} />
                  {t('artistDetail.loading')}
                </div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                  {(showAudiomuseSimilar ? serverSimilarArtists : similarArtists)
                    .slice(0, isMobile && similarCollapsed ? 5 : undefined)
                    .map(a => (
                      <button
                        key={a.id}
                        className="artist-ext-link"
                        onClick={() => navigate(`/artist/${a.id}`)}
                      >
                        {a.name}
                      </button>
                    ))}
                </div>
              )}
            </Fragment>
          );

          case 'albums': return (
            <Fragment key="albums">
              <h2 className="section-title" style={{ marginTop: sectionMt('albums'), marginBottom: '1rem' }}>
                {t('artistDetail.albumsBy', { name: artist.name })}
              </h2>
              {albums.length > 0 ? (
                <div className="album-grid-wrap album-grid-wrap--artist">
                  {albums.map(a => <AlbumCard key={a.id} album={a} />)}
                </div>
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
                  {featuredAlbums.map(a => <AlbumCard key={a.id} album={a} />)}
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
