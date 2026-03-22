import React, { useState, useRef, useEffect, useCallback, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Music, Star, ExternalLink, MicVocal } from 'lucide-react';
import { usePlayerStore } from '../store/playerStore';
import { useLyricsStore } from '../store/lyricsStore';
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
  similarArtists: Array<{ id: string; name: string }>;
  onArtistClick: (id: string) => void;
}

function strHash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return h;
}

function TagCloud({ similarArtists, onArtistClick }: TagCloudProps) {
  const { t } = useTranslation();
  if (similarArtists.length === 0) return null;

  const getTagStyle = (name: string, idx: number): React.CSSProperties => {
    const h = strHash(name);
    const sizePool = [10, 11, 12, 13, 14, 15, 16];
    const size = sizePool[(h + idx * 7) % sizePool.length];
    const weight = size >= 15 ? 600 : size >= 13 ? 500 : 400;
    const pad = size >= 15 ? '5px 10px' : '4px 8px';
    const opacity = 0.6 + ((h % 5) * 0.08);
    const verticals = [-5, -3, -1, 0, 2, 4, 5, -4, 2, -2, 4, 0, 3, -3, 1];
    const ty = verticals[(h + idx * 4) % verticals.length];
    return { fontSize: `${size}px`, fontWeight: weight, padding: pad, opacity, transform: `translateY(${ty}px)` };
  };

  return (
    <div className="np-tag-cloud">
      <div className="np-tag-cloud-header">{t('artistDetail.similarArtists')}</div>
      {([similarArtists.slice(0, 3), similarArtists.slice(3, 6)] as const).map((row, rowIdx) => (
        <div key={rowIdx} className="np-tag-cloud-tags" style={rowIdx === 0 ? { marginBottom: '14px' } : undefined}>
          {row.map((a, i) => (
            <span
              key={a.id}
              className="np-tag np-tag-clickable"
              style={getTagStyle(a.name, rowIdx * 3 + i)}
              onClick={() => onArtistClick(a.id)}
              data-tooltip={t('nowPlaying.goToArtist')}
            >
              {a.name}
            </span>
          ))}
        </div>
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

// ─── Album Tracklist ──────────────────────────────────────────────────────────

interface NpTrackListProps {
  albumTracks: SubsonicSong[];
  currentTrackId: string;
  album: string;
  albumId?: string;
  onNavigate: (path: string) => void;
}

const NpTrackList = memo(function NpTrackList({ albumTracks, currentTrackId, album, albumId, onNavigate }: NpTrackListProps) {
  const { t } = useTranslation();
  if (albumTracks.length === 0) return null;
  return (
    <div className="np-info-card">
      <div className="np-card-header">
        <h3 className="np-card-title">{t('nowPlaying.fromAlbum')}: <em style={{ fontStyle: 'normal', color: 'rgba(255,255,255,0.6)' }}>{album}</em></h3>
        {albumId && (
          <button className="np-card-link" onClick={() => onNavigate(`/album/${albumId}`)}>
            {t('nowPlaying.viewAlbum')} <ExternalLink size={12} />
          </button>
        )}
      </div>
      <div className="np-album-tracklist">
        {albumTracks.map(track => {
          const isActive = track.id === currentTrackId;
          return (
            <div key={track.id}
              className={`np-album-track${isActive ? ' active' : ''}`}
              onClick={() => albumId && onNavigate(`/album/${albumId}`)}
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
  );
});

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function NowPlaying() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const currentTrack    = usePlayerStore(s => s.currentTrack);
  const isPlaying       = usePlayerStore(s => s.isPlaying);
  const showLyrics      = useLyricsStore(s => s.showLyrics);
  const activeTab       = useLyricsStore(s => s.activeTab);
  const isQueueVisible  = usePlayerStore(s => s.isQueueVisible);
  const toggleQueue     = usePlayerStore(s => s.toggleQueue);

  const stableNavigate = useCallback((path: string) => navigate(path), [navigate]);

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

  // Ambilight — sample 8 zones (4 corners + 4 edge midpoints)
  const [ambilightColors, setAmbilightColors] = useState({
    tl: '0,0,0', tc: '0,0,0', tr: '0,0,0',
    ml: '0,0,0',                             mr: '0,0,0',
    bl: '0,0,0', bc: '0,0,0', br: '0,0,0',
  });
  useEffect(() => {
    if (!resolvedCover) return;
    const img = new Image();
    img.onload = () => {
      const S = 30;
      const canvas = document.createElement('canvas');
      canvas.width = S; canvas.height = S;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, S, S);
      const data = ctx.getImageData(0, 0, S, S).data;
      const t = Math.floor(S * 0.25), m = Math.floor(S * 0.5), b2 = Math.floor(S * 0.75);
      const avg = (x0: number, y0: number, x1: number, y1: number) => {
        let r = 0, g = 0, b = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const i = (y * S + x) * 4;
          r += data[i]; g += data[i+1]; b += data[i+2]; n++;
        }
        return `${Math.round(r/n)},${Math.round(g/n)},${Math.round(b/n)}`;
      };
      setAmbilightColors({
        tl: avg(0, 0, t, t),         tc: avg(t, 0, b2, t),        tr: avg(b2, 0, S, t),
        ml: avg(0, t, t, b2),                                       mr: avg(b2, t, S, b2),
        bl: avg(0, b2, t, S),        bc: avg(t, b2, b2, S),        br: avg(b2, b2, S, S),
      });
    };
    img.src = resolvedCover;
  }, [resolvedCover]);


  const similarArtists = artistInfo?.similarArtist ?? [];

  return (
    <div className="np-page">
      <NpBg url={resolvedCover ?? ''} />

      <div className="np-main">
        {currentTrack ? (
          <>
            {/* ── Hero Card ── */}
            <div className="np-hero-card">

              {/* Left: meta info */}
              <div className="np-hero-left">
                <div className="np-hero-info">
                  <div className="np-title" style={{ color: 'var(--accent)' }}>{currentTrack.title}</div>
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
                    <button
                      className="np-star-btn"
                      onClick={() => { if (!isQueueVisible) toggleQueue(); showLyrics(); }}
                      data-tooltip={t('player.lyrics')}
                      style={{ color: activeTab === 'lyrics' && isQueueVisible ? 'var(--accent)' : 'white' }}
                    >
                      <MicVocal size={17} />
                    </button>
                  </div>
                </div>
              </div>

              {/* Center: cover */}
              <div className="np-hero-cover-wrap">
                <div style={{
                  position: 'absolute', inset: '-20px', zIndex: 0,
                  background: `
                    radial-gradient(circle at 0%   0%,   rgba(${ambilightColors.tl},0.85) 0%, transparent 55%),
                    radial-gradient(circle at 50%  0%,   rgba(${ambilightColors.tc},0.85) 0%, transparent 55%),
                    radial-gradient(circle at 100% 0%,   rgba(${ambilightColors.tr},0.85) 0%, transparent 55%),
                    radial-gradient(circle at 0%   50%,  rgba(${ambilightColors.ml},0.85) 0%, transparent 55%),
                    radial-gradient(circle at 100% 50%,  rgba(${ambilightColors.mr},0.85) 0%, transparent 55%),
                    radial-gradient(circle at 0%   100%, rgba(${ambilightColors.bl},0.85) 0%, transparent 55%),
                    radial-gradient(circle at 50%  100%, rgba(${ambilightColors.bc},0.85) 0%, transparent 55%),
                    radial-gradient(circle at 100% 100%, rgba(${ambilightColors.br},0.85) 0%, transparent 55%)
                  `,
                  filter: 'blur(28px)',
                }} />
                {resolvedCover
                  ? <img src={resolvedCover} alt="" className="np-cover" style={{ position: 'relative', zIndex: 1 }} />
                  : <div className="np-cover np-cover-fallback" style={{ position: 'relative', zIndex: 1 }}><Music size={52} /></div>
                }
              </div>

              {/* Right: tag cloud */}
              <TagCloud
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

            <NpTrackList
              albumTracks={albumTracks}
              currentTrackId={currentTrack.id}
              album={currentTrack.album}
              albumId={currentTrack.albumId}
              onNavigate={stableNavigate}
            />
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
