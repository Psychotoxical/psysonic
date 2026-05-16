import { buildCoverArtUrl, coverArtCacheKey } from '../api/subsonicStreamUrl';
import { getRandomAlbums, getAlbum } from '../api/subsonicLibrary';
import type { SubsonicAlbum } from '../api/subsonicTypes';
import { songToTrack } from '../utils/playback/songToTrack';
import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, ListPlus, ChevronLeft, ChevronRight } from 'lucide-react';
import CachedImage, { useCachedUrl } from './CachedImage';
import { usePlayerStore } from '../store/playerStore';
import { useTranslation } from 'react-i18next';
import { playAlbum } from '../utils/playback/playAlbum';
import { useIsMobile } from '../hooks/useIsMobile';
import { useWindowVisibility } from '../hooks/useWindowVisibility';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import { filterAlbumsByMixRatings, getMixMinRatingsConfigFromAuth } from '../utils/mix/mixRatingFilter';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';

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
  const perfFlags = usePerfProbeFlags();
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
  const [windowBlurred, setWindowBlurred] = useState<boolean>(() => Boolean(window.__psyBlurred));
  const heroRef = useRef<HTMLDivElement | null>(null);
  const heroScrollRootRef = useRef<HTMLElement | null>(null);
  const visibilityRafRef = useRef<number | null>(null);
  const [heroInView, setHeroInView] = useState(true);
  const heroInViewRef = useRef(true);
  heroInViewRef.current = heroInView;

  const computeHeroVisibleNow = useCallback((): boolean => {
    const node = heroRef.current;
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    if (rect.height <= 0 || rect.width <= 0) {
      return false;
    }
    const root = heroScrollRootRef.current;
    const viewportTop = root ? root.getBoundingClientRect().top : 0;
    const viewportBottom = root ? root.getBoundingClientRect().bottom : window.innerHeight;
    const overlap = Math.max(0, Math.min(rect.bottom, viewportBottom) - Math.max(rect.top, viewportTop));
    // Consider hero visible only when at least a meaningful slice is on screen.
    const minVisiblePx = Math.min(56, rect.height * 0.2);
    return overlap >= minVisiblePx;
  }, []);

  const updateHeroVisibility = useCallback(() => {
    const visible = computeHeroVisibleNow();
    setHeroInView(prev => (prev === visible ? prev : visible));
  }, [computeHeroVisibleNow]);

  useEffect(() => {
    const node = heroRef.current;
    if (!node) return;
    // Prefer the nearest actual scrolling ancestor; class fallback for safety.
    let scrollRoot: HTMLElement | null = null;
    let parent = node.parentElement;
    while (parent) {
      const styles = window.getComputedStyle(parent);
      const overflowY = styles.overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight + 2) {
        scrollRoot = parent;
        break;
      }
      parent = parent.parentElement;
    }
    heroScrollRootRef.current =
      scrollRoot ?? (node.closest('.app-shell-route-scroll__viewport') as HTMLElement | null);
    updateHeroVisibility();
    const root = heroScrollRootRef.current;
    const onScroll = () => {
      if (visibilityRafRef.current != null) return;
      visibilityRafRef.current = window.requestAnimationFrame(() => {
        visibilityRafRef.current = null;
        updateHeroVisibility();
      });
    };
    const onResize = () => updateHeroVisibility();
    const onFocusLike = () => updateHeroVisibility();
    root?.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    window.addEventListener('focus', onFocusLike);
    document.addEventListener('visibilitychange', onFocusLike);
    return () => {
      root?.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('focus', onFocusLike);
      document.removeEventListener('visibilitychange', onFocusLike);
      if (visibilityRafRef.current != null) {
        window.cancelAnimationFrame(visibilityRafRef.current);
        visibilityRafRef.current = null;
      }
    };
  }, [updateHeroVisibility]);

  useEffect(() => {
    const updateBlurState = () => {
      setWindowBlurred(Boolean(window.__psyBlurred));
    };
    window.addEventListener('focus', updateBlurState);
    window.addEventListener('blur', updateBlurState);
    updateBlurState();
    return () => {
      window.removeEventListener('focus', updateBlurState);
      window.removeEventListener('blur', updateBlurState);
    };
  }, []);

  useEffect(() => {
    if (heroInView || windowHidden) return;
    // Recovery guard: if a scroll/RAF event was missed while hero was outside
    // viewport, keep checking briefly so autoplay/background resume immediately
    // after returning into view.
    const id = window.setInterval(() => {
      updateHeroVisibility();
    }, 220);
    return () => window.clearInterval(id);
  }, [heroInView, windowHidden, updateHeroVisibility]);

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
    if (len <= 1 || windowHidden || windowBlurred || !heroInViewRef.current || !computeHeroVisibleNow()) return;
    timerRef.current = setInterval(() => {
      const visibleNow = computeHeroVisibleNow();
      if (!visibleNow && heroInViewRef.current) setHeroInView(false);
      if (document.hidden || window.__psyHidden || window.__psyBlurred || !heroInViewRef.current || !visibleNow) {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
        return;
      }
      setActiveIdx(prev => (prev + 1) % len);
    }, INTERVAL_MS);
  }, [windowHidden, windowBlurred, computeHeroVisibleNow]);

  useEffect(() => {
    // Hard-stop timer immediately when hero leaves viewport.
    if (heroInView && !windowBlurred) return;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, [heroInView, windowBlurred]);

  useEffect(() => {
    startTimer(albums.length);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [albums.length, heroInView, startTimer]);

  const goPrev = useCallback(() => {
    const len = albums.length;
    if (len <= 1) return;
    setActiveIdx(prev => (prev - 1 + len) % len);
    startTimer(len);
  }, [albums.length, startTimer]);

  const goNext = useCallback(() => {
    const len = albums.length;
    if (len <= 1) return;
    setActiveIdx(prev => (prev + 1) % len);
    startTimer(len);
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
      ref={heroRef}
      className="hero"
      role="banner"
      aria-label={t('hero.eyebrow')}
      onClick={() => navigate(`/album/${album.id}`)}
      style={{ cursor: 'pointer' }}
    >
      {enableCoverArtBackground && !perfFlags.disableMainstageHeroBackdrop && heroInView && <HeroBg url={stableBgUrl.current} />}
      {enableCoverArtBackground && !perfFlags.disableMainstageHeroBackdrop && heroInView && <div className="hero-overlay" aria-hidden="true" />}

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

      {/* Carousel navigation arrows + decorative dot indicators */}
      {albums.length > 1 && (
        <>
          <div className="hero-nav" aria-hidden="false">
            <button
              type="button"
              className="hero-nav-arrow hero-nav-arrow--left"
              onClick={e => { e.stopPropagation(); goPrev(); }}
              aria-label={t('hero.previousAlbum')}
              data-tooltip={t('hero.previousAlbum')}
            >
              <ChevronLeft size={24} />
            </button>
            <button
              type="button"
              className="hero-nav-arrow hero-nav-arrow--right"
              onClick={e => { e.stopPropagation(); goNext(); }}
              aria-label={t('hero.nextAlbum')}
              data-tooltip={t('hero.nextAlbum')}
            >
              <ChevronRight size={24} />
            </button>
          </div>
          <div className="hero-dots" aria-hidden="true">
            {albums.map((_, i) => (
              <span
                key={i}
                className={`hero-dot${i === activeIdx ? ' hero-dot-active' : ''}`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
