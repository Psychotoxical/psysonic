import React, { useState, useCallback, useMemo, useRef, useEffect, CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown, Play, Pause, SkipBack, SkipForward,
  Shuffle, Repeat, Repeat1, Heart, Music, MicVocal, ListMusic, X,
} from 'lucide-react';
import { usePlayerStore, Track } from '../store/playerStore';
import { buildCoverArtUrl, coverArtCacheKey, star, unstar } from '../api/subsonic';
import { useCachedUrl } from './CachedImage';
import LyricsPane from './LyricsPane';

// ── Color extraction ──────────────────────────────────────────────────────────
// Samples a 16×16 canvas to find the most vibrant (highest-saturation,
// medium-dark) pixel. Returns an "R, G, B" string for use in rgba().

function extractVibrantColor(imageUrl: string): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve('0,0,0'); return; }
      ctx.drawImage(img, 0, 0, 16, 16);
      const { data } = ctx.getImageData(0, 0, 16, 16);
      let bestR = 0, bestG = 0, bestB = 0, bestScore = -1;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const max = Math.max(r, g, b) / 255;
        const min = Math.min(r, g, b) / 255;
        const l = (max + min) / 2;
        const s = max === min ? 0 : (max - min) / (l > 0.5 ? 2 - max - min : max + min);
        // Prefer saturated pixels in the medium-dark range (l 0.2–0.6)
        const score = s * (1 - Math.abs(l - 0.4));
        if (score > bestScore) {
          bestScore = score;
          bestR = r; bestG = g; bestB = b;
        }
      }
      resolve(`${bestR},${bestG},${bestB}`);
    };
    img.onerror = () => resolve('0,0,0');
    img.src = imageUrl;
  });
}

function useAlbumAccentColor(imageUrl: string): string {
  const [color, setColor] = useState('0,0,0');
  useEffect(() => {
    if (!imageUrl) { setColor('0,0,0'); return; }
    let cancelled = false;
    extractVibrantColor(imageUrl).then(c => { if (!cancelled) setColor(c); });
    return () => { cancelled = true; };
  }, [imageUrl]);
  return color;
}

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Queue Drawer ──────────────────────────────────────────────────────────────

function QueueDrawer({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const queue = usePlayerStore(s => s.queue);
  const queueIndex = usePlayerStore(s => s.queueIndex);
  const playTrack = usePlayerStore(s => s.playTrack);
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll active track into view on open
  useEffect(() => {
    const el = listRef.current?.querySelector('.mq-item.active');
    el?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, []);

  return (
    <div className="mq-drawer-backdrop" onClick={onClose}>
      <div className="mq-drawer" onClick={e => e.stopPropagation()}>
        <div className="mq-drawer-header">
          <h3>{t('queue.title')}</h3>
          <span className="mq-drawer-count">
            {queue.length} {queue.length === 1 ? t('queue.trackSingular') : t('queue.trackPlural')}
          </span>
          <button className="mq-drawer-close" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="mq-drawer-list" ref={listRef}>
          {queue.length === 0 ? (
            <div className="mq-drawer-empty">{t('queue.emptyQueue')}</div>
          ) : (
            queue.map((track, idx) => {
              const isActive = idx === queueIndex;
              return (
                <div
                  key={`${track.id}-${idx}`}
                  className={`mq-item${isActive ? ' active' : ''}`}
                  onClick={() => { playTrack(track, queue); onClose(); }}
                >
                  <div className="mq-item-info">
                    <div className="mq-item-title">
                      {isActive && <Play size={10} fill="currentColor" style={{ flexShrink: 0 }} />}
                      <span className="truncate">{track.title}</span>
                    </div>
                    <div className="mq-item-artist truncate">{track.artist}</div>
                  </div>
                  <span className="mq-item-dur">{formatTime(track.duration)}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ── Lyrics Drawer ─────────────────────────────────────────────────────────────

function LyricsDrawer({ onClose, currentTrack }: { onClose: () => void; currentTrack: Track | null }) {
  const { t } = useTranslation();

  return (
    <div className="mq-drawer-backdrop" onClick={onClose}>
      <div className="mq-drawer mq-drawer-lyrics" onClick={e => e.stopPropagation()}>
        <div className="mq-drawer-header">
          <h3>{t('player.lyrics')}</h3>
          <button className="mq-drawer-close" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="mq-drawer-list">
          <LyricsPane currentTrack={currentTrack} />
        </div>
      </div>
    </div>
  );
}

// ── Mobile Player View ────────────────────────────────────────────────────────

export default function MobilePlayerView() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // Lock body scroll while full-screen player is mounted
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const currentTrack = usePlayerStore(s => s.currentTrack);
  const isPlaying    = usePlayerStore(s => s.isPlaying);
  const progress     = usePlayerStore(s => s.progress);
  const currentTime  = usePlayerStore(s => s.currentTime);
  const togglePlay   = usePlayerStore(s => s.togglePlay);
  const next         = usePlayerStore(s => s.next);
  const previous     = usePlayerStore(s => s.previous);
  const seek         = usePlayerStore(s => s.seek);
  const repeatMode   = usePlayerStore(s => s.repeatMode);
  const toggleRepeat = usePlayerStore(s => s.toggleRepeat);
  const shuffleQueue = usePlayerStore(s => s.shuffleQueue);
  const starredOverrides = usePlayerStore(s => s.starredOverrides);
  const setStarredOverride = usePlayerStore(s => s.setStarredOverride);

  const duration = currentTrack?.duration ?? 0;

  // Cover art
  const coverFetchUrl = useMemo(
    () => currentTrack?.coverArt ? buildCoverArtUrl(currentTrack.coverArt, 800) : '',
    [currentTrack?.coverArt]
  );
  const coverKey = currentTrack?.coverArt ? coverArtCacheKey(currentTrack.coverArt, 800) : '';
  const resolvedCover = useCachedUrl(coverFetchUrl, coverKey);

  // Dynamic background color extracted from cover art
  const accentColor = useAlbumAccentColor(resolvedCover);

  // Star / favorite
  const isStarred = currentTrack
    ? (currentTrack.id in starredOverrides ? starredOverrides[currentTrack.id] : !!currentTrack.starred)
    : false;

  const toggleStar = useCallback(async () => {
    if (!currentTrack) return;
    const nextVal = !isStarred;
    setStarredOverride(currentTrack.id, nextVal);
    try {
      if (nextVal) await star(currentTrack.id, 'song');
      else await unstar(currentTrack.id, 'song');
    } catch {
      setStarredOverride(currentTrack.id, !nextVal);
    }
  }, [currentTrack, isStarred, setStarredOverride]);

  // Scrubber touch/mouse drag
  const scrubberRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);
  const [previewProgress, setPreviewProgress] = useState<number | null>(null);

  const setPreviewSeek = useCallback((pct: number) => {
    pendingSeekRef.current = pct;
    setPreviewProgress(pct);
  }, []);

  const seekFromX = useCallback((clientX: number) => {
    const el = scrubberRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setPreviewSeek(pct);
  }, [setPreviewSeek]);

  const onScrubStart = useCallback((clientX: number) => {
    isDragging.current = true;
    seekFromX(clientX);
  }, [seekFromX]);

  useEffect(() => {
    const onMove = (e: TouchEvent | MouseEvent) => {
      if (!isDragging.current) return;
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
      seekFromX(clientX);
    };
    const onEnd = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      const pending = pendingSeekRef.current;
      pendingSeekRef.current = null;
      setPreviewProgress(null);
      if (pending !== null) seek(pending);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
    };
  }, [seekFromX]);

  useEffect(() => {
    pendingSeekRef.current = null;
    setPreviewProgress(null);
  }, [currentTrack?.id]);

  // Drawers
  const [showQueue, setShowQueue] = useState(false);
  const [showLyrics, setShowLyrics] = useState(false);

  // ── Empty state ──
  if (!currentTrack) {
    return (
      <div className="mp-view">
        <div className="mp-header">
          <button className="mp-back" onClick={() => navigate(-1)} aria-label={t('player.back')}>
            <ChevronDown size={28} />
          </button>
          <span className="mp-header-title">{t('sidebar.nowPlaying')}</span>
          <div style={{ width: 44 }} />
        </div>
        <div className="mp-empty">
          <Music size={56} style={{ opacity: 0.25 }} />
          <p>{t('nowPlaying.nothingPlaying')}</p>
        </div>
      </div>
    );
  }

  const bgStyle: CSSProperties = {
    background: `radial-gradient(ellipse 160% 55% at 50% 20%, rgba(${accentColor}, 0.38) 0%, var(--bg-app) 65%)`,
  };
  const effectiveProgress = previewProgress ?? progress;
  const effectiveTime =
    previewProgress !== null && duration > 0
      ? previewProgress * duration
      : currentTime;

  return (
    <div className="mp-view" style={bgStyle}>
      {/* Header */}
      <div className="mp-header">
        <button className="mp-back" onClick={() => navigate(-1)} aria-label={t('player.back')}>
          <ChevronDown size={28} />
        </button>
        <span className="mp-header-title">{t('sidebar.nowPlaying')}</span>
        <div style={{ width: 44 }} />
      </div>

      {/* Cover Art */}
      <div className="mp-cover-wrap">
        {resolvedCover ? (
          <img src={resolvedCover} alt="" className="mp-cover" />
        ) : (
          <div className="mp-cover mp-cover-fallback">
            <Music size={64} />
          </div>
        )}
      </div>

      {/* Track Metadata */}
      <div className="mp-meta">
        <div className="mp-meta-text">
          <div className="mp-title truncate">{currentTrack.title}</div>
          <div
            className="mp-artist truncate"
            onClick={() => currentTrack.artistId && navigate(`/artist/${currentTrack.artistId}`)}
            style={{ cursor: currentTrack.artistId ? 'pointer' : 'default' }}
          >
            {currentTrack.artist}
          </div>
          {(() => {
            const parts = [
              currentTrack.year,
              currentTrack.genre,
              currentTrack.suffix?.toUpperCase(),
              currentTrack.bitRate ? `${currentTrack.bitRate} kbps` : null,
            ].filter(Boolean);
            return parts.length > 0
              ? <div className="mp-track-info truncate">{parts.join(' • ')}</div>
              : null;
          })()}
        </div>
        <button
          className={`mp-heart${isStarred ? ' active' : ''}`}
          onClick={toggleStar}
          aria-label={isStarred ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
        >
          <Heart size={22} fill={isStarred ? 'currentColor' : 'none'} />
        </button>
      </div>

      {/* Scrubber */}
      <div className="mp-scrubber-wrap">
        <div
          className="mp-scrubber"
          ref={scrubberRef}
          onMouseDown={e => onScrubStart(e.clientX)}
          onTouchStart={e => onScrubStart(e.touches[0].clientX)}
        >
          <div className="mp-scrubber-bg" />
          <div className="mp-scrubber-fill" style={{ width: `${effectiveProgress * 100}%` }} />
          <div className="mp-scrubber-thumb" style={{ left: `${effectiveProgress * 100}%` }} />
        </div>
        <div className="mp-scrubber-times">
          <span>{formatTime(effectiveTime)}</span>
          <span>-{formatTime(Math.max(0, duration - effectiveTime))}</span>
        </div>
      </div>

      {/* Transport Controls */}
      <div className="mp-controls">
        <button
          className="mp-ctrl-btn mp-ctrl-sm"
          onClick={() => shuffleQueue()}
          aria-label={t('queue.shuffle')}
        >
          <Shuffle size={20} />
        </button>
        <button className="mp-ctrl-btn" onClick={() => previous()} aria-label={t('player.prev')}>
          <SkipBack size={28} />
        </button>
        <button className="mp-ctrl-btn mp-ctrl-play" onClick={togglePlay} aria-label={isPlaying ? t('player.pause') : t('player.play')}>
          {isPlaying ? <Pause size={32} fill="currentColor" /> : <Play size={32} fill="currentColor" />}
        </button>
        <button className="mp-ctrl-btn" onClick={() => next()} aria-label={t('player.next')}>
          <SkipForward size={28} />
        </button>
        <button
          className={`mp-ctrl-btn mp-ctrl-sm`}
          onClick={toggleRepeat}
          aria-label={t('player.repeat')}
          style={{ color: repeatMode !== 'off' ? 'var(--accent)' : undefined }}
        >
          {repeatMode === 'one' ? <Repeat1 size={20} /> : <Repeat size={20} />}
        </button>
      </div>

      {/* Utility Footer */}
      <div className="mp-footer">
        <button className="mp-footer-btn" onClick={() => setShowLyrics(true)}>
          <MicVocal size={20} />
          <span>{t('player.lyrics')}</span>
        </button>
        <button className="mp-footer-btn" onClick={() => setShowQueue(true)}>
          <ListMusic size={20} />
          <span>{t('queue.title')}</span>
        </button>
      </div>

      {/* Queue Drawer */}
      {showQueue && <QueueDrawer onClose={() => setShowQueue(false)} />}

      {/* Lyrics Drawer */}
      {showLyrics && <LyricsDrawer onClose={() => setShowLyrics(false)} currentTrack={currentTrack} />}
    </div>
  );
}
