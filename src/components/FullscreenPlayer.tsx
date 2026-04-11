import React, { useCallback, useEffect, useState, useRef, memo, useMemo } from 'react';
import {
  Play, Pause, SkipBack, SkipForward,
  ChevronDown, Repeat, Repeat1, Square, Music, Heart, MicVocal
} from 'lucide-react';
import { usePlayerStore } from '../store/playerStore';
import { buildCoverArtUrl, coverArtCacheKey, getArtistInfo, star, unstar } from '../api/subsonic';
import { useCachedUrl } from './CachedImage';
import { getCachedUrl } from '../utils/imageCache';
import { extractCoverColors } from '../utils/dynamicColors';
import { useTranslation } from 'react-i18next';
import { useLyrics } from '../hooks/useLyrics';
import { useAuthStore } from '../store/authStore';
import type { LrcLine } from '../api/lrclib';
import type { Track } from '../store/playerStore';

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Fullscreen lyrics overlay ────────────────────────────────────────────────
// Slot height = 6vh = window.innerHeight * 0.06 — must match CSS height: 6vh.
// railY = (2 - activeIdx) * slotH centers slot `activeIdx` in a 5-slot window:
//   activeIdx=0 → railY=+2×slotH  (line 0 at slot 2)
//   activeIdx=2 → railY=0         (line 2 at center)
//   activeIdx=5 → railY=-3×slotH  (line 5 at slot 2)

const FsLyrics = memo(function FsLyrics({ currentTrack }: { currentTrack: Track | null }) {
  const { syncedLines, loading } = useLyrics(currentTrack);
  const lines = syncedLines as LrcLine[] | null;
  const hasSynced = lines !== null && lines.length > 0;

  // Keep a ref so the zustand selector can read lines without closing over
  // a changing variable — avoids re-creating the selector on every render.
  const linesRef = useRef<LrcLine[]>([]);
  linesRef.current = hasSynced ? lines! : [];

  // Selector returns the active line INDEX — zustand only re-renders when it
  // actually changes, dropping us from ~10 Hz to ~0.2 Hz re-renders.
  const activeIdx = usePlayerStore(s => {
    const ls = linesRef.current;
    if (ls.length === 0) return -1;
    return ls.reduce((acc, line, i) => s.currentTime >= line.time ? i : acc, -1);
  });

  const duration = usePlayerStore(s => s.currentTrack?.duration ?? 0);
  const seek     = usePlayerStore(s => s.seek);

  // Cache slotH — avoids forcing a layout read (window.innerHeight) on every render.
  const slotH = useRef(window.innerHeight * 0.06);
  useEffect(() => {
    const onResize = () => { slotH.current = window.innerHeight * 0.06; };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Event delegation — one handler for all lyric lines instead of N closures per tick.
  const handleLineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-time]');
    if (!target || duration <= 0) return;
    seek(parseFloat(target.dataset.time!) / duration);
  }, [duration, seek]);

  if (!currentTrack || loading || !hasSynced) return null;

  const railY = (2 - Math.max(0, activeIdx)) * slotH.current;

  return (
    <div className="fs-lyrics-overlay" aria-hidden="true">
      <div
        className="fs-lyrics-rail"
        style={{ transform: `translateY(${railY}px)` }}
        onClick={handleLineClick}
      >
        {lines!.map((line, i) => (
          <div
            key={i}
            className={`fs-lyric-line${i === activeIdx ? ' fsl-active' : i < activeIdx ? ' fsl-past' : ''}`}
            data-time={line.time}
          >
            {line.text || '\u00A0'}
          </div>
        ))}
      </div>
    </div>
  );
});

// ─── Album art box — crossfades layers so old art stays visible while new loads ─
// Uses 300px thumbnails (portrait fallback uses 500px separately).
//
// Why onLoad instead of new Image() preload:
//   React batches setLayers(add invisible) + rAF setLayers(make visible) into one
//   commit, so the browser never sees opacity:0 and the CSS transition never fires.
//   Using the DOM img's own onLoad guarantees the element was painted at opacity:0
//   before we flip it to 1.
const FsArt = memo(function FsArt({ fetchUrl, cacheKey }: { fetchUrl: string; cacheKey: string }) {
  // true = show raw fetchUrl immediately as fallback while blob resolves.
  // PlayerBar uses 128px; FS player uses 300px — different cache keys, no warm hit.
  // Showing the URL directly avoids the multi-second blank wait.
  const blobUrl = useCachedUrl(fetchUrl, cacheKey, true);

  const [layers, setLayers] = useState<Array<{ src: string; id: number; vis: boolean }>>([]);
  const counter = useRef(0);
  const cleanupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Add a new invisible layer whenever the blob URL changes.
  useEffect(() => {
    if (!blobUrl) return;
    const id = ++counter.current;
    setLayers(prev => [...prev, { src: blobUrl, id, vis: false }]);
  }, [blobUrl]);

  // Called by the DOM <img> once it has painted at opacity:0 — now safe to transition.
  // Cancel any pending cleanup timer so a stale setTimeout from a previous layer
  // cannot remove the layer we are making visible right now.
  const handleLoad = useCallback((id: number) => {
    if (cleanupTimer.current) clearTimeout(cleanupTimer.current);
    setLayers(prev => prev.map(l => ({ ...l, vis: l.id === id })));
    cleanupTimer.current = setTimeout(() => setLayers(prev => prev.filter(l => l.id === id)), 400);
  }, []);

  if (layers.length === 0) {
    return <div className="fs-art fs-art-placeholder"><Music size={40} /></div>;
  }

  return (
    <>
      {layers.map(l => (
        <img
          key={l.id}
          src={l.src}
          className="fs-art"
          style={{ opacity: l.vis ? 1 : 0 }}
          onLoad={() => handleLoad(l.id)}
          alt=""
          decoding="async"
        />
      ))}
    </>
  );
});

// ─── Artist portrait — right half, crossfades on track change ─────────────────
const FsPortrait = memo(function FsPortrait({ url }: { url: string }) {
  const [layers, setLayers] = useState<Array<{ url: string; id: number; visible: boolean }>>(() =>
    url ? [{ url, id: 0, visible: true }] : []
  );
  const counterRef = useRef(1);
  const cleanupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const id = counterRef.current++;
    const img = new Image();
    img.onload = img.onerror = () => {
      if (cancelled) return;
      setLayers(prev => [...prev, { url, id, visible: false }]);
      requestAnimationFrame(() => {
        if (cancelled) return;
        if (cleanupTimer.current) clearTimeout(cleanupTimer.current);
        setLayers(prev => prev.map(l => ({ ...l, visible: l.id === id })));
        cleanupTimer.current = setTimeout(() => {
          if (!cancelled) setLayers(prev => prev.filter(l => l.id === id));
        }, 1000);
      });
    };
    img.src = url;
    return () => { cancelled = true; };
  }, [url]);

  if (layers.length === 0) return null;

  return (
    <div className="fs-portrait-wrap" aria-hidden="true">
      {layers.map(layer => (
        <img
          key={layer.id}
          src={layer.url}
          className="fs-portrait"
          style={{ opacity: layer.visible ? 1 : 0 }}
          decoding="async"
          loading="eager"
          alt=""
        />
      ))}
    </div>
  );
});

// ─── Full-width seekbar — imperative DOM updates, zero React re-renders on tick ─
const FsSeekbar = memo(function FsSeekbar({ duration }: { duration: number }) {
  const seek        = usePlayerStore(s => s.seek);
  const timeRef     = useRef<HTMLSpanElement>(null);
  const playedRef   = useRef<HTMLDivElement>(null);
  const bufRef      = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const s = usePlayerStore.getState();
    const pct = s.progress * 100;
    if (timeRef.current)   timeRef.current.textContent  = formatTime(s.currentTime);
    if (playedRef.current) playedRef.current.style.width = `${pct}%`;
    if (bufRef.current)    bufRef.current.style.width    = `${Math.max(pct, s.buffered * 100)}%`;
    if (inputRef.current)  inputRef.current.value        = String(s.progress);

    return usePlayerStore.subscribe(state => {
      const p = state.progress * 100;
      if (timeRef.current)   timeRef.current.textContent  = formatTime(state.currentTime);
      if (playedRef.current) playedRef.current.style.width = `${p}%`;
      if (bufRef.current)    bufRef.current.style.width    = `${Math.max(p, state.buffered * 100)}%`;
      if (inputRef.current)  inputRef.current.value        = String(state.progress);
    });
  }, []);

  const handleSeek = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => seek(parseFloat(e.target.value)),
    [seek]
  );

  return (
    <div className="fs-seekbar-wrap">
      <div className="fs-seekbar-times">
        <span ref={timeRef} />
        <span>{formatTime(duration)}</span>
      </div>
      <div className="fs-seekbar">
        <div className="fs-seekbar-bg" />
        <div className="fs-seekbar-buf" ref={bufRef} />
        <div className="fs-seekbar-played" ref={playedRef} />
        <input
          ref={inputRef}
          type="range" min={0} max={1} step={0.001}
          defaultValue={0}
          onChange={handleSeek}
          aria-label="seek"
        />
      </div>
    </div>
  );
});

// ─── Play/Pause button (isolated — subscribes to isPlaying only) ──────────────
const FsPlayBtn = memo(function FsPlayBtn() {
  const { t } = useTranslation();
  const isPlaying  = usePlayerStore(s => s.isPlaying);
  const togglePlay = usePlayerStore(s => s.togglePlay);
  return (
    <button className="fs-btn fs-btn-play" onClick={togglePlay} aria-label={isPlaying ? t('player.pause') : t('player.play')}>
      {isPlaying ? <Pause size={25} /> : <Play size={25} fill="currentColor" />}
    </button>
  );
});

// ─── Main component ────────────────────────────────────────────────────────────
interface FullscreenPlayerProps {
  onClose: () => void;
}

// Module-level cache: artKey → accent color string.
// Survives track changes so same-album songs reuse the extracted color instantly.
const coverAccentCache = new Map<string, string>();

export default function FullscreenPlayer({ onClose }: FullscreenPlayerProps) {
  const { t } = useTranslation();
  const currentTrack       = usePlayerStore(s => s.currentTrack);
  const repeatMode         = usePlayerStore(s => s.repeatMode);
  const next               = usePlayerStore(s => s.next);
  const previous           = usePlayerStore(s => s.previous);
  const stop               = usePlayerStore(s => s.stop);
  const toggleRepeat       = usePlayerStore(s => s.toggleRepeat);
  const setStarredOverride = usePlayerStore(s => s.setStarredOverride);
  // Derive isStarred inside the selector so we only re-render when the boolean
  // actually flips — not when any unrelated track's star status changes.
  const isStarred = usePlayerStore(s => {
    const track = s.currentTrack;
    if (!track) return false;
    return track.id in s.starredOverrides ? s.starredOverrides[track.id] : !!track.starred;
  });

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

  const duration = currentTrack?.duration ?? 0;

  // buildCoverArtUrl generates a new salt on every call — must be memoized.
  // 300px for the small art box; 500px for the right-side portrait fallback.
  const artUrl  = useMemo(() => currentTrack?.coverArt ? buildCoverArtUrl(currentTrack.coverArt, 300) : '', [currentTrack?.coverArt]);
  const artKey  = useMemo(() => currentTrack?.coverArt ? coverArtCacheKey(currentTrack.coverArt, 300) : '', [currentTrack?.coverArt]);
  const coverUrl = useMemo(() => currentTrack?.coverArt ? buildCoverArtUrl(currentTrack.coverArt, 500) : '', [currentTrack?.coverArt]);
  const coverKey = useMemo(() => currentTrack?.coverArt ? coverArtCacheKey(currentTrack.coverArt, 500) : '', [currentTrack?.coverArt]);
  // `false` = no fetchUrl fallback — prevents double crossfade (fetchUrl → blobUrl).
  const resolvedCoverUrl = useCachedUrl(coverUrl, coverKey, false);

  // Dynamic accent color extracted from the current album cover.
  // Applied as --dynamic-fs-accent on the root element so it inherits to all
  // children; CSS rules use var(--dynamic-fs-accent, var(--accent)) as fallback.
  // Reset to null on track change so the previous color doesn't linger while
  // the new one is being extracted.
  const [dynamicAccent, setDynamicAccent] = useState<string | null>(null);

  // On cover change: hit cache for instant result, or fetch → extract → cache.
  // Cache hit avoids re-fetching for same-album tracks. Reset only when uncached.
  useEffect(() => {
    if (!artKey || !artUrl) { setDynamicAccent(null); return; }
    const cached = coverAccentCache.get(artKey);
    if (cached) { setDynamicAccent(cached); return; }
    // No cache hit — keep the previous color visible until extraction completes.
    let cancelled = false;
    let blobUrl = '';
    (async () => {
      try {
        const resp = await fetch(artUrl);
        if (cancelled) return;
        const blob = await resp.blob();
        if (cancelled) return;
        blobUrl = URL.createObjectURL(blob);
        const colors = await extractCoverColors(blobUrl);
        if (cancelled) return;
        if (colors.accent) {
          coverAccentCache.set(artKey, colors.accent);
          setDynamicAccent(colors.accent);
        }
      } catch { /* ignore */ } finally {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      }
    })();
    return () => { cancelled = true; };
  }, [artKey]);

  // Artist image → portrait on right. Falls back to cover art.
  const [artistBgUrl, setArtistBgUrl] = useState<string>('');
  useEffect(() => {
    setArtistBgUrl('');
    const artistId = currentTrack?.artistId;
    if (!artistId) return;
    let cancelled = false;
    getArtistInfo(artistId).then(info => {
      if (!cancelled && info.largeImageUrl) setArtistBgUrl(info.largeImageUrl);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [currentTrack?.artistId]);

  const portraitUrl = artistBgUrl || resolvedCoverUrl;
  const showFullscreenLyrics   = useAuthStore(s => s.showFullscreenLyrics);
  const showFsArtistPortrait   = useAuthStore(s => s.showFsArtistPortrait);
  const fsPortraitDim          = useAuthStore(s => s.fsPortraitDim);

  // Pre-fetch next track's 300px cover into the IndexedDB cache.
  // Selector returns only the coverArt id, so it only re-runs on actual changes.
  const nextCoverArt = usePlayerStore(s => {
    const q = s.queue;
    const idx = s.queueIndex;
    return (idx >= 0 && idx + 1 < q.length) ? (q[idx + 1]?.coverArt ?? null) : null;
  });
  useEffect(() => {
    if (!nextCoverArt) return;
    const url = buildCoverArtUrl(nextCoverArt, 300);
    const key = coverArtCacheKey(nextCoverArt, 300);
    getCachedUrl(url, key).catch(() => {});
  }, [nextCoverArt]);

  // Idle-fade system — hides controls after 3 s of inactivity
  const [isIdle, setIsIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetIdle = useCallback(() => {
    setIsIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIsIdle(true), 3000);
  }, []);

  // Throttled wrapper for mousemove — avoids clearing/setting timeouts on every pixel.
  const lastMoveTime = useRef(0);
  const handleMouseMove = useCallback(() => {
    const now = Date.now();
    if (now - lastMoveTime.current < 200) return;
    lastMoveTime.current = now;
    resetIdle();
  }, [resetIdle]);

  useEffect(() => {
    resetIdle();
    return () => { if (idleTimer.current) clearTimeout(idleTimer.current); };
  }, [resetIdle]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      resetIdle();
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, resetIdle]);

  const metaParts = useMemo(() => [
    currentTrack?.album,
    currentTrack?.year?.toString(),
    currentTrack?.suffix?.toUpperCase(),
    currentTrack?.bitRate ? `${currentTrack.bitRate} kbps` : '',
  ].filter(Boolean), [currentTrack]);

  return (
    <div
      className="fs-player"
      role="dialog"
      aria-modal="true"
      aria-label={t('player.fullscreen')}
      data-idle={isIdle}
      onMouseMove={handleMouseMove}
      style={{
        ...(dynamicAccent ? { '--dynamic-fs-accent': dynamicAccent } : {}),
        '--fs-portrait-dim': String(fsPortraitDim / 100),
      } as React.CSSProperties}
    >

      {/* Layer 0 — animated dark mesh gradient (real divs = will-change possible) */}
      <div className="fs-mesh-bg" aria-hidden="true">
        <div className="fs-mesh-blob fs-mesh-blob-a" />
        <div className="fs-mesh-blob fs-mesh-blob-b" />
      </div>

      {/* Layer 1 — artist portrait, right half, object-fit: contain */}
      {showFsArtistPortrait && <FsPortrait url={portraitUrl} />}

      {/* Layer 2 — horizontal scrim: dark left → transparent right */}
      <div className="fs-scrim" aria-hidden="true" />

      {/* Close */}
      <button className="fs-close" onClick={onClose} aria-label={t('player.closeFullscreen')}>
        <ChevronDown size={28} />
      </button>

      {/* Lyrics overlay — upper-left quadrant, above cluster */}
      {showFullscreenLyrics && <FsLyrics currentTrack={currentTrack} />}

      {/* Layer 3 — info cluster, bottom-left */}
      <div className="fs-cluster">

        {/* Album art */}
        <div className="fs-art-wrap">
          <FsArt fetchUrl={artUrl} cacheKey={artKey} />
        </div>

        {/* Track title — massive statement */}
        <p className="fs-track-title">{currentTrack?.title ?? '—'}</p>

        {/* Artist — secondary, below track */}
        <p className="fs-artist-name">{currentTrack?.artist ?? '—'}</p>

        {/* Metadata row */}
        {metaParts.length > 0 && (
          <div className="fs-meta">
            {metaParts.map((part, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="fs-meta-dot">·</span>}
                <span>{part}</span>
              </React.Fragment>
            ))}
          </div>
        )}

        {/* Controls */}
        <div className="fs-controls">
          <button className="fs-btn fs-btn-sm" onClick={stop} aria-label="Stop" data-tooltip={t('player.stop')}>
            <Square size={13} fill="currentColor" />
          </button>
          <button className="fs-btn" onClick={() => previous()} aria-label={t('player.prev')} data-tooltip={t('player.prev')}>
            <SkipBack size={19} />
          </button>
          <FsPlayBtn />
          <button className="fs-btn" onClick={() => next()} aria-label={t('player.next')} data-tooltip={t('player.next')}>
            <SkipForward size={19} />
          </button>
          <button
            className={`fs-btn fs-btn-sm${repeatMode !== 'off' ? ' active' : ''}`}
            onClick={toggleRepeat}
            aria-label={t('player.repeat')}
            data-tooltip={`${t('player.repeat')}: ${repeatMode === 'off' ? t('player.repeatOff') : repeatMode === 'all' ? t('player.repeatAll') : t('player.repeatOne')}`}
          >
            {repeatMode === 'one' ? <Repeat1 size={14} /> : <Repeat size={14} />}
          </button>
          {currentTrack && (
            <button
              className={`fs-btn fs-btn-sm fs-btn-heart${isStarred ? ' active' : ''}`}
              onClick={toggleStar}
              aria-label={isStarred ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
              data-tooltip={isStarred ? t('contextMenu.unfavorite') : t('contextMenu.favorite')}
            >
              <Heart size={14} fill={isStarred ? 'currentColor' : 'none'} />
            </button>
          )}
          <button
            className="fs-btn fs-btn-sm"
            onClick={() => useAuthStore.getState().setShowFullscreenLyrics(!showFullscreenLyrics)}
            aria-label={t('player.fsLyricsToggle')}
            data-tooltip={t('player.fsLyricsToggle')}
            style={{ color: showFullscreenLyrics ? (dynamicAccent ?? 'var(--accent)') : 'rgba(255,255,255,0.35)' }}
          >
            <MicVocal size={14} />
          </button>
        </div>

      </div>

      {/* Layer 4 — full-width seekbar, bottom edge */}
      <FsSeekbar duration={duration} />

    </div>
  );
}
