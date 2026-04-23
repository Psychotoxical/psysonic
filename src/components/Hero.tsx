import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, ListPlus } from 'lucide-react';
import { getRandomAlbums, SubsonicAlbum, buildCoverArtUrl, coverArtCacheKey, getAlbum } from '../api/subsonic';
import CachedImage, { useCachedUrl } from './CachedImage';
import { usePlayerStore, songToTrack } from '../store/playerStore';
import { useTranslation } from 'react-i18next';
import { playAlbum } from '../utils/playAlbum';
import { useIsMobile } from '../hooks/useIsMobile';
import { useWindowVisibility } from '../hooks/useWindowVisibility';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import { filterAlbumsByMixRatings, getMixMinRatingsConfigFromAuth } from '../utils/mixRatingFilter';

const INTERVAL_MS = 10000;
const HERO_ALBUM_COUNT = 8;
/** Larger pool when mix rating filter is on so we can still fill the hero strip. */
const HERO_RANDOM_POOL = 32;

// Crossfading background — same layer pattern as FullscreenPlayer
function HeroBg({ url }: { url: string }) {
  const [layers, setLayers] = useState<Array<{ url: string; id: number; visible: boolean }>>(() =>
    url ? [{ url, id: 0, visible: true }] : []
  );
  const counter = useRef(1);

  useEffect(() => {
    if (!url) return;
    const id = counter.current++;
    setLayers(prev => [...prev, { url, id, visible: false }]);
    const t1 = setTimeout(() => setLayers(prev => prev.map(l => ({ ...l, visible: l.id === id }))), 20);
    const t2 = setTimeout(() => setLayers(prev => prev.filter(l => l.id === id)), 900);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [url]);

  return (
    <>
      {layers.map(layer => (
        <div
          key={layer.id}
          className="hero-bg"
          style={{
            backgroundImage: `url(${layer.url})`,
            opacity: layer.visible ? 1 : 0,
          }}
          aria-hidden="true"
        />
      ))}
    </>
  );
}

interface HeroProps {
  albums?: SubsonicAlbum[];
}

export default function Hero({ albums: albumsProp }: HeroProps = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const musicLibraryFilterVersion = useAuthStore(s => s.musicLibraryFilterVersion);
  const mixMinRatingFilterEnabled = useAuthStore(s => s.mixMinRatingFilterEnabled);
  const enableCoverArtBackground = useThemeStore(s => s.enableCoverArtBackground);
  const mixMinRatingAlbum = useAuthStore(s => s.mixMinRatingAlbum);
  const mixMinRatingArtist = useAuthStore(s => s.mixMinRatingArtist);
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const windowHidden = useWindowVisibility();

  useEffect(() => {
    if (albumsProp?.length) { setAlbums(albumsProp); return; }
    const cfg = { ...getMixMinRatingsConfigFromAuth(), minSong: 0 };
    const albumMix = cfg.enabled && (cfg.minAlbum > 0 || cfg.minArtist > 0);
    const pool = albumMix ? HERO_RANDOM_POOL : HERO_ALBUM_COUNT;
    getRandomAlbums(pool)
      .then(async raw => {
        const list = albumMix
          ? (await filterAlbumsByMixRatings(raw, cfg)).slice(0, HERO_ALBUM_COUNT)
          : raw;
        setAlbums(list);
      })
      .catch(() => {});
  }, [
    albumsProp,
    musicLibraryFilterVersion,
    mixMinRatingFilterEnabled,
    mixMinRatingAlbum,
    mixMinRatingArtist,
  ]);

  // Start / restart auto-advance timer (paused while the Tauri window is hidden).
  const startTimer = useCallback((len: number) => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (len <= 1 || windowHidden) return;
    timerRef.current = setInterval(() => {
      if (document.hidden || (window as any).__psyHidden) return;
      setActiveIdx(prev => (prev + 1) % len);
    }, INTERVAL_MS);
  }, [windowHidden]);

  useEffect(() => {
    startTimer(albums.length);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [albums.length, startTimer]);

  const goTo = useCallback((idx: number) => {
    setActiveIdx(idx);
    startTimer(albums.length);
  }, [albums.length, startTimer]);

  const album = albums[activeIdx] ?? null;

  // Lazily fetch format label for the currently-visible album (cached by id)
  const [albumFormats, setAlbumFormats] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!album || albumFormats[album.id] !== undefined) return;
    getAlbum(album.id).then(data => {
      const fmts = [...new Set(data.songs.map(s => s.suffix).filter((f): f is string => !!f))];
      setAlbumFormats(prev => ({ ...prev, [album.id]: fmts.map(f => f.toUpperCase()).join(' / ') }));
    }).catch(() => {
      setAlbumFormats(prev => ({ ...prev, [album.id]: '' }));
    });
  }, [album?.id]);

  // buildCoverArtUrl generates a new salt on every call — must be memoized.
  const bgRawUrl    = useMemo(() => album?.coverArt ? buildCoverArtUrl(album.coverArt, 800) : '', [album?.coverArt]);
  const bgCacheKey  = useMemo(() => album?.coverArt ? coverArtCacheKey(album.coverArt, 800) : '', [album?.coverArt]);
  const resolvedBgUrl = useCachedUrl(bgRawUrl, bgCacheKey);

  // Keep the last known good URL so HeroBg never receives '' during a cache-miss
  // transition (which would cause the background to flash empty before fading in).
  const stableBgUrl = useRef('');
  if (resolvedBgUrl) stableBgUrl.current = resolvedBgUrl;

  const coverRawUrl  = useMemo(() => album?.coverArt ? buildCoverArtUrl(album.coverArt, 300) : '', [album?.coverArt]);
  const coverCacheKey = useMemo(() => album?.coverArt ? coverArtCacheKey(album.coverArt, 300) : '', [album?.coverArt]);

  if (!album) return <div className="hero-placeholder" />;

  return (
    <div
      className="hero"
      role="banner"
      aria-label={t('hero.eyebrow')}
      onClick={() => navigate(`/album/${album.id}`)}
      style={{ cursor: 'pointer' }}
    >
      {enableCoverArtBackground && <HeroBg url={stableBgUrl.current} />}
      {enableCoverArtBackground && <div className="hero-overlay" aria-hidden="true" />}

      {/* key causes re-mount → animate-fade-in triggers on each album change */}
      <div className="hero-content animate-fade-in" key={album.id}>
        {coverRawUrl && !isMobile && (
          <CachedImage
            className="hero-cover"
            src={coverRawUrl}
            cacheKey={coverCacheKey}
            alt={`${album.name} Cover`}
          />
        )}
        <div className="hero-text">
          <span className="hero-eyebrow">{t('hero.eyebrow')}</span>
          <h2 className="hero-title">{album.name}</h2>
          <p className="hero-artist">{album.artist}</p>
          <div className="hero-meta">
            {album.year && <span className="badge">{album.year}</span>}
            {album.genre && <span className="badge">{album.genre}</span>}
            {!isMobile && album.songCount && <span className="badge">{album.songCount} Tracks</span>}
            {!isMobile && albumFormats[album.id] && <span className="badge">{albumFormats[album.id]}</span>}
          </div>
          {isMobile ? (
            <div className="hero-actions-mobile" onClick={e => e.stopPropagation()}>
              <button
                className="album-icon-btn album-icon-btn--play"
                onClick={e => { e.stopPropagation(); playAlbum(album.id); }}
                aria-label={`${t('hero.playAlbum')} ${album.name}`}
              >
                <Play size={22} fill="currentColor" />
              </button>
              <button
                className="album-icon-btn album-icon-btn--queue"
                onClick={async e => {
                  e.stopPropagation();
                  try {
                    const albumData = await getAlbum(album.id);
                    usePlayerStore.getState().enqueue(albumData.songs.map(songToTrack));
                  } catch (_) {}
                }}
                aria-label={t('hero.enqueue')}
                data-tooltip={t('hero.enqueueTooltip')}
              >
                <ListPlus size={20} />
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <button
                className="hero-play-btn"
                id="hero-play-btn"
                onClick={e => { e.stopPropagation(); playAlbum(album.id); }}
                aria-label={`${t('hero.playAlbum')} ${album.name}`}
              >
                <Play size={18} fill="currentColor" />
                {t('hero.playAlbum')}
              </button>
              <button
                className="btn btn-surface"
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    const albumData = await getAlbum(album.id);
                    const tracks = albumData.songs.map(songToTrack);
                    usePlayerStore.getState().enqueue(tracks);
                  } catch (_) {}
                }}
                style={{ padding: '0 1.5rem', fontWeight: 600, fontSize: '0.95rem' }}
                data-tooltip={t('hero.enqueueTooltip')}
              >
                <ListPlus size={18} />
                {t('hero.enqueue')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Carousel dot indicators */}
      {albums.length > 1 && (
        <div className="hero-dots" onClick={e => e.stopPropagation()}>
          {albums.map((_, i) => (
            <button
              key={i}
              className={`hero-dot${i === activeIdx ? ' hero-dot-active' : ''}`}
              onClick={() => goTo(i)}
              aria-label={`Album ${i + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
