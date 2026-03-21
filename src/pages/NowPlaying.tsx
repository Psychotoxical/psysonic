import React, { useState, useRef, useEffect, useCallback, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Music, Star, ExternalLink } from 'lucide-react';
import { usePlayerStore } from '../store/playerStore';
import {
  buildCoverArtUrl, coverArtCacheKey, getSong, star, unstar,
  getAlbum, getArtistInfo,
  SubsonicSong, SubsonicArtistInfo,
} from '../api/subsonic';
import { useCachedUrl } from '../components/CachedImage';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(s: number): string {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

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

function renderStars(rating?: number) {
  if (!rating) return null;
  return (
    <div style={{ display: 'flex', gap: '3px', alignItems: 'center' }}>
      {[1, 2, 3, 4, 5].map(i => (
        <Star key={i} size={13}
          fill={i <= rating ? 'var(--ctp-yellow)' : 'none'}
          color={i <= rating ? 'var(--ctp-yellow)' : 'rgba(255,255,255,0.4)'}
        />
      ))}
    </div>
  );
}

// ─── Animated EQ Bars ─────────────────────────────────────────────────────────

const BAR_COUNT = 24;

const EQBars = memo(function EQBars({ isPlaying }: { isPlaying: boolean }) {
  const barsRef    = useRef<(HTMLDivElement | null)[]>([]);
  const heights    = useRef<number[]>(Array.from({ length: BAR_COUNT }, () => 0.08));
  const targets    = useRef<number[]>(Array.from({ length: BAR_COUNT }, () => Math.random() * 0.5 + 0.1));
  const speeds     = useRef<number[]>(Array.from({ length: BAR_COUNT }, () => 0.06 + Math.random() * 0.08));
  const rafRef     = useRef<number>();

  const animate = useCallback(() => {
    heights.current = heights.current.map((h, i) => {
      const t = targets.current[i];
      const newH = h + (t - h) * speeds.current[i];
      if (Math.abs(newH - t) < 0.015) {
        targets.current[i] = Math.random() * 0.88 + 0.06;
        speeds.current[i] = 0.05 + Math.random() * 0.10;
      }
      return newH;
    });
    barsRef.current.forEach((bar, i) => {
      if (bar) bar.style.height = `${Math.round(heights.current[i] * 100)}%`;
    });
    rafRef.current = requestAnimationFrame(animate);
  }, []);

  useEffect(() => {
    if (isPlaying) {
      rafRef.current = requestAnimationFrame(animate);
    } else {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      // Settle bars to a low resting height
      heights.current = heights.current.map(() => 0.08);
      barsRef.current.forEach(bar => {
        if (bar) bar.style.height = '8%';
      });
    }
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [isPlaying, animate]);

  return (
    <div className="np-eq-wrap">
      <div className="np-eq-bars">
        {Array.from({ length: BAR_COUNT }).map((_, i) => (
          <div
            key={i}
            className="np-eq-bar"
            ref={el => { barsRef.current[i] = el; }}
          />
        ))}
      </div>
    </div>
  );
});

// ─── Tag Cloud ────────────────────────────────────────────────────────────────

interface TagCloudProps {
  genre?: string;
  year?: number;
  similarArtists: Array<{ id: string; name: string }>;
  onArtistClick: (id: string) => void;
}

function TagCloud({ genre, year, similarArtists, onArtistClick }: TagCloudProps) {
  const { t } = useTranslation();
  const hasTags = genre || year || similarArtists.length > 0;
  if (!hasTags) return null;

  return (
    <div className="np-tag-cloud">
      {genre && <span className="np-tag np-tag-accent">{genre}</span>}
      {year && <span className="np-tag">{year}</span>}
      {similarArtists.slice(0, 6).map(a => (
        <span
          key={a.id}
          className="np-tag np-tag-clickable"
          onClick={() => onArtistClick(a.id)}
          data-tooltip={t('nowPlaying.goToArtist')}
        >
          {a.name}
        </span>
      ))}
    </div>
  );
}

// ─── Blurred background ───────────────────────────────────────────────────────

const NpBg = memo(function NpBg({ url }: { url: string }) {
  const [layers, setLayers] = useState<Array<{ url: string; id: number; visible: boolean }>>(() =>
    url ? [{ url, id: 0, visible: true }] : []
  );
  const nextId = useRef(1);

  useEffect(() => {
    if (!url) return;
    const id = nextId.current++;
    setLayers(prev => [...prev, { url, id, visible: false }]);
    const t1 = setTimeout(() => setLayers(prev => prev.map(l => ({ ...l, visible: l.id === id }))), 30);
    const t2 = setTimeout(() => setLayers(prev => prev.filter(l => l.id === id)), 700);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [url]);

  return (
    <div className="np-bg-wrap">
      {layers.map(l => (
        <div key={l.id} className="np-bg-layer"
          style={{ backgroundImage: `url(${l.url})`, opacity: l.visible ? 1 : 0 }}
        />
      ))}
      <div className="np-bg-overlay" />
    </div>
  );
});

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function NowPlaying() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const currentTrack    = usePlayerStore(s => s.currentTrack);
  const isPlaying       = usePlayerStore(s => s.isPlaying);
  const setQueueVisible = usePlayerStore(s => s.setQueueVisible);

  // Hide queue panel while on this page, restore on leave
  useEffect(() => {
    const wasVisible = usePlayerStore.getState().isQueueVisible;
    if (wasVisible) setQueueVisible(false);
    return () => { if (wasVisible) setQueueVisible(true); };
  }, [setQueueVisible]);

  // Extra song metadata
  const [songMeta, setSongMeta] = useState<SubsonicSong | null>(null);
  useEffect(() => {
    if (!currentTrack) { setSongMeta(null); return; }
    getSong(currentTrack.id).then(setSongMeta);
  }, [currentTrack?.id]);

  // Artist info (bio + similar artists)
  const [artistInfo, setArtistInfo] = useState<SubsonicArtistInfo | null>(null);
  useEffect(() => {
    if (!currentTrack?.artistId) { setArtistInfo(null); return; }
    getArtistInfo(currentTrack.artistId).then(setArtistInfo).catch(() => setArtistInfo(null));
  }, [currentTrack?.artistId]);

  // Album tracks
  const [albumTracks, setAlbumTracks] = useState<SubsonicSong[]>([]);
  useEffect(() => {
    if (!currentTrack?.albumId) { setAlbumTracks([]); return; }
    getAlbum(currentTrack.albumId).then(d => setAlbumTracks(d.songs)).catch(() => setAlbumTracks([]));
  }, [currentTrack?.albumId]);

  // Bio expand toggle
  const [bioExpanded, setBioExpanded] = useState(false);
  useEffect(() => { setBioExpanded(false); }, [currentTrack?.artistId]);

  // Favorite
  const [starred, setStarred] = useState(false);
  useEffect(() => { setStarred(!!songMeta?.starred); }, [songMeta]);
  const toggleStar = async () => {
    if (!currentTrack) return;
    if (starred) { await unstar(currentTrack.id, 'song'); setStarred(false); }
    else          { await star(currentTrack.id, 'song');   setStarred(true);  }
  };

  // Cover
  const coverFetchUrl = currentTrack?.coverArt ? buildCoverArtUrl(currentTrack.coverArt, 800) : '';
  const coverKey      = currentTrack?.coverArt ? coverArtCacheKey(currentTrack.coverArt, 800) : '';
  const resolvedCover = useCachedUrl(coverFetchUrl, coverKey);

  const similarArtists = artistInfo?.similarArtist ?? [];

  return (
    <div className="np-page">
      <NpBg url={resolvedCover ?? ''} />

      <div className="np-main">
        {currentTrack ? (
          <>
            {/* ── Hero Card ── */}
            <div className="np-hero-card">

              {/* Left: cover + meta info */}
              <div className="np-hero-left">
                <div className="np-hero-cover-wrap">
                  {resolvedCover && <img src={resolvedCover} alt="" className="np-cover-glow" aria-hidden />}
                  {resolvedCover
                    ? <img src={resolvedCover} alt="" className="np-cover" />
                    : <div className="np-cover np-cover-fallback"><Music size={52} /></div>
                  }
                </div>
                <div className="np-hero-info">
                  <div className="np-title">{currentTrack.title}</div>
                  <div className="np-artist-album">
                    <span className="np-link"
                      onClick={() => currentTrack.artistId && navigate(`/artist/${currentTrack.artistId}`)}
                      style={{ cursor: currentTrack.artistId ? 'pointer' : 'default' }}
                    >{currentTrack.artist}</span>
                    <span className="np-sep">·</span>
                    <span className="np-link"
                      onClick={() => currentTrack.albumId && navigate(`/album/${currentTrack.albumId}`)}
                      style={{ cursor: currentTrack.albumId ? 'pointer' : 'default' }}
                    >{currentTrack.album}</span>
                    {currentTrack.year && <><span className="np-sep">·</span><span>{currentTrack.year}</span></>}
                  </div>
                  <div className="np-tech-row">
                    {songMeta?.genre && <span className="np-badge">{songMeta.genre}</span>}
                    {currentTrack.suffix && <span className="np-badge">{currentTrack.suffix.toUpperCase()}</span>}
                    {currentTrack.bitRate && <span className="np-badge">{currentTrack.bitRate} kbps</span>}
                    {currentTrack.duration && <span className="np-badge">{formatTime(currentTrack.duration)}</span>}
                    {renderStars(currentTrack.userRating)}
                    <button onClick={toggleStar} className="np-star-btn"
                      data-tooltip={starred ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
                    >
                      <Star size={17} fill={starred ? 'var(--ctp-yellow)' : 'none'} color={starred ? 'var(--ctp-yellow)' : 'white'} />
                    </button>
                  </div>
                </div>
              </div>

              {/* Center: EQ bars */}
              <EQBars isPlaying={isPlaying} />

              {/* Right: tag cloud */}
              <TagCloud
                genre={songMeta?.genre}
                year={currentTrack.year}
                similarArtists={similarArtists}
                onArtistClick={id => navigate(`/artist/${id}`)}
              />

            </div>

            {/* ── About the Artist ── */}
            {(artistInfo?.biography || artistInfo?.largeImageUrl) && (
              <div className="np-info-card">
                <div className="np-card-header">
                  <h3 className="np-card-title">{t('nowPlaying.aboutArtist')}</h3>
                  {currentTrack.artistId && (
                    <button className="np-card-link" onClick={() => navigate(`/artist/${currentTrack.artistId}`)}>
                      {t('nowPlaying.goToArtist')} <ExternalLink size={12} />
                    </button>
                  )}
                </div>
                <div className="np-artist-bio-row">
                  {artistInfo.largeImageUrl && (
                    <img src={artistInfo.largeImageUrl} alt={currentTrack.artist} className="np-artist-thumb" />
                  )}
                  {artistInfo.biography && (
                    <div className="np-bio-wrap">
                      <div
                        className={`np-bio-text${bioExpanded ? ' expanded' : ''}`}
                        dangerouslySetInnerHTML={{ __html: sanitizeHtml(artistInfo.biography) }}
                      />
                      <button className="np-bio-toggle" onClick={() => setBioExpanded(v => !v)}>
                        {bioExpanded ? t('nowPlaying.showLess') : t('nowPlaying.readMore')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── From this Album ── */}
            {albumTracks.length > 0 && (
              <div className="np-info-card">
                <div className="np-card-header">
                  <h3 className="np-card-title">{t('nowPlaying.fromAlbum')}: <em style={{ fontStyle: 'normal', color: 'rgba(255,255,255,0.6)' }}>{currentTrack.album}</em></h3>
                  {currentTrack.albumId && (
                    <button className="np-card-link" onClick={() => navigate(`/album/${currentTrack.albumId}`)}>
                      {t('nowPlaying.viewAlbum')} <ExternalLink size={12} />
                    </button>
                  )}
                </div>
                <div className="np-album-tracklist">
                  {albumTracks.map(track => {
                    const isActive = track.id === currentTrack.id;
                    return (
                      <div key={track.id}
                        className={`np-album-track${isActive ? ' active' : ''}`}
                        onClick={() => currentTrack.albumId && navigate(`/album/${currentTrack.albumId}`)}
                      >
                        <span className="np-album-track-num">
                          {isActive
                            ? <Star size={10} fill="var(--accent)" color="var(--accent)" />
                            : track.track ?? '—'
                          }
                        </span>
                        <span className="np-album-track-title truncate">{track.title}</span>
                        <span className="np-album-track-dur">{formatTime(track.duration)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="np-empty-state">
            <Music size={48} style={{ opacity: 0.3 }} />
            <p>{t('nowPlaying.nothingPlaying')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
