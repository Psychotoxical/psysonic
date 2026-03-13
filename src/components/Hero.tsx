import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, ListPlus } from 'lucide-react';
import { getRandomAlbums, SubsonicAlbum, buildCoverArtUrl, coverArtCacheKey, getAlbum } from '../api/subsonic';
import CachedImage, { useCachedUrl } from './CachedImage';
import { usePlayerStore } from '../store/playerStore';
import { useTranslation } from 'react-i18next';

const INTERVAL_MS = 10000;

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
            filter: layer.visible ? 'blur(0px)' : 'blur(18px)',
          }}
          aria-hidden="true"
        />
      ))}
    </>
  );
}

export default function Hero() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [albums, setAlbums] = useState<SubsonicAlbum[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    getRandomAlbums(8).then(a => { if (a.length) setAlbums(a); }).catch(() => {});
  }, []);

  // Start / restart auto-advance timer
  const startTimer = useCallback((len: number) => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (len <= 1) return;
    timerRef.current = setInterval(() => {
      setActiveIdx(prev => (prev + 1) % len);
    }, INTERVAL_MS);
  }, []);

  useEffect(() => {
    startTimer(albums.length);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [albums.length, startTimer]);

  const goTo = useCallback((idx: number) => {
    setActiveIdx(idx);
    startTimer(albums.length);
  }, [albums.length, startTimer]);

  const album = albums[activeIdx] ?? null;

  // Resolve background URL via cache
  const bgRawUrl = album?.coverArt ? buildCoverArtUrl(album.coverArt, 800) : '';
  const bgCacheKey = album?.coverArt ? coverArtCacheKey(album.coverArt, 800) : '';
  const resolvedBgUrl = useCachedUrl(bgRawUrl, bgCacheKey);

  // Resolve cover thumbnail via cache
  const coverRawUrl = album?.coverArt ? buildCoverArtUrl(album.coverArt, 300) : '';
  const coverCacheKey = album?.coverArt ? coverArtCacheKey(album.coverArt, 300) : '';

  if (!album) return <div className="hero-placeholder" />;

  return (
    <div
      className="hero"
      role="banner"
      aria-label={t('hero.eyebrow')}
      onClick={() => navigate(`/album/${album.id}`)}
      style={{ cursor: 'pointer' }}
    >
      <HeroBg url={resolvedBgUrl} />
      <div className="hero-overlay" aria-hidden="true" />

      {/* key causes re-mount → animate-fade-in triggers on each album change */}
      <div className="hero-content animate-fade-in" key={album.id}>
        {coverRawUrl && (
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
            {album.songCount && <span className="badge">{album.songCount} Tracks</span>}
          </div>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            <button
              className="hero-play-btn"
              id="hero-play-btn"
              onClick={e => { e.stopPropagation(); navigate(`/album/${album.id}`); }}
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
                  const tracks = albumData.songs.map(s => ({
                    id: s.id, title: s.title, artist: s.artist, album: s.album,
                    albumId: s.albumId, artistId: s.artistId, duration: s.duration, coverArt: s.coverArt, track: s.track,
                    year: s.year, bitRate: s.bitRate, suffix: s.suffix, userRating: s.userRating,
                  }));
                  usePlayerStore.getState().enqueue(tracks);
                } catch (_) { }
              }}
              style={{ padding: '0 1.5rem', fontWeight: 600, fontSize: '0.95rem' }}
              data-tooltip={t('hero.enqueueTooltip')}
            >
              <ListPlus size={18} />
              {t('hero.enqueue')}
            </button>
          </div>
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
