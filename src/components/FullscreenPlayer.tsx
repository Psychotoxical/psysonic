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
import { useLyrics, type WordLyricsLine } from '../hooks/useLyrics';
import { useAuthStore } from '../store/authStore';
import type { LrcLine } from '../api/lrclib';
import type { Track } from '../store/playerStore';
import { EaseScroller, targetForFraction } from '../utils/easeScroll';

function formatTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Apple Music-style fullscreen lyrics ─────────────────────────────────────
// Full-screen scrollable list. Active line auto-scrolls to ~35% from top.
// Word-sync runs imperatively (no React re-renders on every time tick).
// User scroll pauses auto-scroll for 4 s then resumes.

const FsLyricsApple = memo(function FsLyricsApple({ currentTrack }: { currentTrack: Track | null }) {
  const { syncedLines, wordLines, plainLyrics, loading } = useLyrics(currentTrack);
  const staticOnly = useAuthStore(s => s.lyricsStaticOnly);

  const useWords = !staticOnly && wordLines !== null && wordLines.length > 0;
  const lineSrc: LrcLine[] | null = useWords
    ? (wordLines as WordLyricsLine[]).map(l => ({ time: l.time, text: l.text }))
    : (syncedLines as LrcLine[] | null);
  const hasSynced = !staticOnly && lineSrc !== null && lineSrc.length > 0;

  const duration = usePlayerStore(s => s.currentTrack?.duration ?? 0);
  const seek     = usePlayerStore(s => s.seek);

  const linesRef    = useRef<LrcLine[]>([]);
  linesRef.current  = hasSynced ? lineSrc! : [];

  // React state only for the active line index — changes are infrequent.
  const [activeIdx, setActiveIdx]   = useState(-1);
  const activeIdxRef                = useRef(-1);

  const containerRef  = useRef<HTMLDivElement | null>(null);
  const scrollerRef   = useRef<EaseScroller | null>(null);
  const lineRefs      = useRef<(HTMLDivElement | null)[]>([]);
  const wordRefs      = useRef<HTMLSpanElement[][]>([]);
  const prevWord      = useRef({ line: -1, word: -1 });
  const isUserScroll  = useRef(false);
  const scrollTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    scrollerRef.current?.stop();
    scrollerRef.current = el ? new EaseScroller(el) : null;
  }, []);

  // Reset everything on track change.
  useEffect(() => {
    lineRefs.current   = [];
    wordRefs.current   = [];
    prevWord.current   = { line: -1, word: -1 };
    activeIdxRef.current = -1;
    setActiveIdx(-1);
    scrollerRef.current?.jump(0);
  }, [currentTrack?.id]);

  // Subscribe to playback time — only triggers React setState when line changes.
  useEffect(() => {
    if (!hasSynced) return;
    const apply = (time: number) => {
      const ls = linesRef.current;
      if (!ls.length) return;
      const idx = ls.reduce((acc, line, i) => time >= line.time ? i : acc, -1);
      if (idx !== activeIdxRef.current) {
        activeIdxRef.current = idx;
        setActiveIdx(idx);
      }
    };
    apply(usePlayerStore.getState().currentTime);
    return usePlayerStore.subscribe(s => apply(s.currentTime));
  }, [hasSynced, currentTrack?.id]);

  // Ease-scroll active line to ~35% from the top of the container.
  useEffect(() => {
    if (activeIdx < 0 || isUserScroll.current) return;
    const el  = lineRefs.current[activeIdx];
    const box = containerRef.current;
    if (!el || !box || !scrollerRef.current) return;
    scrollerRef.current.scrollTo(targetForFraction(box, el, 0.35));
  }, [activeIdx]);

  // Word-sync: imperative DOM updates, zero React re-renders per tick.
  useEffect(() => {
    wordRefs.current = [];
    prevWord.current = { line: -1, word: -1 };
  }, [currentTrack?.id, useWords]);

  useEffect(() => {
    if (!useWords) return;
    const lines = wordLines as WordLyricsLine[];
    const apply = (time: number) => {
      let li = -1;
      for (let i = 0; i < lines.length; i++) { if (time >= lines[i].time) li = i; else break; }
      let wi = -1;
      if (li >= 0) {
        const ws = lines[li].words;
        for (let j = 0; j < ws.length; j++) { if (time >= ws[j].time) wi = j; else break; }
      }
      const prev = prevWord.current;
      if (prev.line === li && prev.word === wi) return;
      if (prev.line !== li && prev.line >= 0 && wordRefs.current[prev.line])
        for (const w of wordRefs.current[prev.line]) w.className = 'fsa-lyric-word';
      if (li >= 0 && wordRefs.current[li]) {
        const ws = wordRefs.current[li];
        for (let j = 0; j < ws.length; j++)
          ws[j].className = j < wi ? 'fsa-lyric-word played' : j === wi ? 'fsa-lyric-word active' : 'fsa-lyric-word';
      }
      prevWord.current = { line: li, word: wi };
    };
    apply(usePlayerStore.getState().currentTime);
    return usePlayerStore.subscribe(s => apply(s.currentTime));
  }, [useWords, wordLines]);

  const handleUserScroll = useCallback(() => {
    scrollerRef.current?.stop();
    isUserScroll.current = true;
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => { isUserScroll.current = false; }, 4000);
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-time]');
    if (!target || duration <= 0) return;
    seek(parseFloat(target.dataset.time!) / duration);
  }, [duration, seek]);

  if (!currentTrack || loading) return null;

  const isPlain = !hasSynced && !!plainLyrics;

  return (
    <div
      className={`fsa-lyrics-container${isPlain ? ' fsa-lyrics-container--plain' : ''}`}
      ref={setContainerRef}
      onWheel={handleUserScroll}
      onTouchMove={handleUserScroll}
      onClick={handleClick}
      aria-hidden="true"
    >
      <div className="fsa-lyrics-top-pad" />

      {hasSynced && (useWords
        ? (wordLines as WordLyricsLine[]).map((line, i) => (
            <div
              key={i}
              ref={el => { lineRefs.current[i] = el; }}
              className={`fsa-lyric-line${i === activeIdx ? ' fsal-active' : i < activeIdx ? ' fsal-past' : ''}`}
              data-time={line.time}
            >
              {line.words.length > 0
                ? line.words.map((w, j) => (
                    <span
                      key={j}
                      className="fsa-lyric-word"
                      ref={el => {
                        if (!wordRefs.current[i]) wordRefs.current[i] = [];
                        if (el) wordRefs.current[i][j] = el;
                      }}
                    >{w.text}</span>
                  ))
                : (line.text || '\u00A0')}
            </div>
          ))
        : lineSrc!.map((line, i) => (
            <div
              key={i}
              ref={el => { lineRefs.current[i] = el; }}
              className={`fsa-lyric-line${i === activeIdx ? ' fsal-active' : i < activeIdx ? ' fsal-past' : ''}`}
              data-time={line.time}
            >
              {line.text || '\u00A0'}
            </div>
          ))
      )}

      {!hasSynced && plainLyrics && (
        <div className="fsa-plain-lyrics">
          {plainLyrics.split('\n').map((line, i) => (
            <p key={i} className="fsa-plain-line">{line || '\u00A0'}</p>
          ))}
        </div>
      )}

      <div className="fsa-lyrics-bottom-pad" />
    </div>
  );
});

// ─── Classic 5-line rail lyrics (original "Rail" style) ──────────────────────
// Slot height = 6vh = window.innerHeight * 0.06 — must match CSS height: 6vh.
const FsLyricsRail = memo(function FsLyricsRail({ currentTrack }: { currentTrack: Track | null }) {
  const { syncedLines, wordLines, loading } = useLyrics(currentTrack);
  const staticOnly = useAuthStore(s => s.lyricsStaticOnly);

  const useWords  = !staticOnly && wordLines !== null && wordLines.length > 0;
  const lineSrc: LrcLine[] | null = useWords
    ? (wordLines as WordLyricsLine[]).map(l => ({ time: l.time, text: l.text }))
    : (syncedLines as LrcLine[] | null);
  const hasSynced = !staticOnly && lineSrc !== null && lineSrc.length > 0;

  const linesRef = useRef<LrcLine[]>([]);
  linesRef.current = hasSynced ? lineSrc! : [];

  const activeIdx = usePlayerStore(s => {
    const ls = linesRef.current;
    if (ls.length === 0) return -1;
    return ls.reduce((acc, line, i) => s.currentTime >= line.time ? i : acc, -1);
  });

  const duration = usePlayerStore(s => s.currentTrack?.duration ?? 0);
  const seek     = usePlayerStore(s => s.seek);

  const slotH = useRef(window.innerHeight * 0.06);
  useEffect(() => {
    const onResize = () => { slotH.current = window.innerHeight * 0.06; };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const handleLineClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-time]');
    if (!target || duration <= 0) return;
    seek(parseFloat(target.dataset.time!) / duration);
  }, [duration, seek]);

  const wordRefs = useRef<HTMLSpanElement[][]>([]);
  const prevWord = useRef<{ line: number; word: number }>({ line: -1, word: -1 });

  useEffect(() => {
    wordRefs.current = [];
    prevWord.current = { line: -1, word: -1 };
  }, [currentTrack?.id, useWords]);

  useEffect(() => {
    if (!useWords) return;
    const lines = wordLines as WordLyricsLine[];
    const apply = (time: number) => {
      let li = -1;
      for (let i = 0; i < lines.length; i++) { if (time >= lines[i].time) li = i; else break; }
      let wi = -1;
      if (li >= 0) {
        const ws = lines[li].words;
        for (let j = 0; j < ws.length; j++) { if (time >= ws[j].time) wi = j; else break; }
      }
      const prev = prevWord.current;
      if (prev.line === li && prev.word === wi) return;
      if (prev.line !== li && prev.line >= 0 && wordRefs.current[prev.line])
        for (const w of wordRefs.current[prev.line]) w.className = 'fsr-lyric-word';
      if (li >= 0 && wordRefs.current[li]) {
        const ws = wordRefs.current[li];
        for (let j = 0; j < ws.length; j++)
          ws[j].className = j < wi ? 'fsr-lyric-word played' : j === wi ? 'fsr-lyric-word active' : 'fsr-lyric-word';
      }
      prevWord.current = { line: li, word: wi };
    };
    apply(usePlayerStore.getState().currentTime);
    return usePlayerStore.subscribe(s => apply(s.currentTime));
  }, [useWords, wordLines]);

  if (!currentTrack || loading || !hasSynced) return null;

  const railY = (2 - Math.max(0, activeIdx)) * slotH.current;

  return (
    <div className="fsr-lyrics-overlay" aria-hidden="true">
      <div
        className="fsr-lyrics-rail"
        style={{ transform: `translateY(${railY}px)` }}
        onClick={handleLineClick}
      >
        {useWords
          ? (wordLines as WordLyricsLine[]).map((line, i) => (
              <div
                key={i}
                className={`fsr-lyric-line${i === activeIdx ? ' fsrl-active' : i < activeIdx ? ' fsrl-past' : ''}`}
                data-time={line.time}
              >
                {line.words.length > 0 ? line.words.map((w, j) => (
                  <span
                    key={j}
                    className="fsr-lyric-word"
                    ref={el => {
                      if (!wordRefs.current[i]) wordRefs.current[i] = [];
                      if (el) wordRefs.current[i][j] = el;
                    }}
                  >{w.text}</span>
                )) : (line.text || '\u00A0')}
              </div>
            ))
          : lineSrc!.map((line, i) => (
              <div
                key={i}
                className={`fsr-lyric-line${i === activeIdx ? ' fsrl-active' : i < activeIdx ? ' fsrl-past' : ''}`}
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
  const isDraggingRef = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);

  const previewSeek = useCallback((progress: number) => {
    const s = usePlayerStore.getState();
    const p = Math.max(0, Math.min(1, progress));
    pendingSeekRef.current = p;
    if (timeRef.current) {
      const previewTime = duration > 0 ? p * duration : s.currentTime;
      timeRef.current.textContent = formatTime(previewTime);
    }
    if (playedRef.current) playedRef.current.style.width = `${p * 100}%`;
    if (bufRef.current) bufRef.current.style.width = `${Math.max(p * 100, s.buffered * 100)}%`;
    if (inputRef.current) inputRef.current.value = String(p);
  }, [duration]);

  const commitSeek = useCallback(() => {
    const pending = pendingSeekRef.current;
    if (pending === null) return;
    pendingSeekRef.current = null;
    seek(pending);
  }, [seek]);

  useEffect(() => {
    const s = usePlayerStore.getState();
    const pct = s.progress * 100;
    if (timeRef.current)   timeRef.current.textContent  = formatTime(s.currentTime);
    if (playedRef.current) playedRef.current.style.width = `${pct}%`;
    if (bufRef.current)    bufRef.current.style.width    = `${Math.max(pct, s.buffered * 100)}%`;
    if (inputRef.current)  inputRef.current.value        = String(s.progress);

    return usePlayerStore.subscribe(state => {
      if (isDraggingRef.current) return;
      const p = state.progress * 100;
      if (timeRef.current)   timeRef.current.textContent  = formatTime(state.currentTime);
      if (playedRef.current) playedRef.current.style.width = `${p}%`;
      if (bufRef.current)    bufRef.current.style.width    = `${Math.max(p, state.buffered * 100)}%`;
      if (inputRef.current)  inputRef.current.value        = String(state.progress);
    });
  }, []);

  const handleSeek = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      previewSeek(parseFloat(e.target.value));
    },
    [previewSeek]
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
          onMouseDown={() => { isDraggingRef.current = true; }}
          onMouseUp={() => { isDraggingRef.current = false; commitSeek(); }}
          onTouchStart={() => { isDraggingRef.current = true; }}
          onTouchEnd={() => { isDraggingRef.current = false; commitSeek(); }}
          onPointerDown={() => { isDraggingRef.current = true; }}
          onPointerUp={() => { isDraggingRef.current = false; commitSeek(); }}
          onKeyUp={commitSeek}
          onBlur={() => { isDraggingRef.current = false; commitSeek(); }}
          aria-label="seek"
        />
      </div>
    </div>
  );
});

// ─── Lyrics settings popover — shown above the mic button ────────────────────
interface FsLyricsMenuProps {
  open: boolean;
  onClose: () => void;
  accentColor: string | null;
  triggerRef?: React.RefObject<HTMLElement | null>;
}
const FsLyricsMenu = memo(function FsLyricsMenu({ open, onClose, accentColor, triggerRef }: FsLyricsMenuProps) {
  const { t } = useTranslation();
  const showLyrics  = useAuthStore(s => s.showFullscreenLyrics);
  const lyricsStyle = useAuthStore(s => s.fsLyricsStyle);
  const setLyrics   = useAuthStore(s => s.setShowFullscreenLyrics);
  const setStyle    = useAuthStore(s => s.setFsLyricsStyle);
  const panelRef    = useRef<HTMLDivElement>(null);

  // Close on click outside the panel or on Escape.
  // Ignore clicks on the trigger button so re-clicking it toggles normally
  // instead of outside-handler closing + click re-opening.
  useEffect(() => {
    if (!open) return;
    const onKey   = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onMouse = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef?.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    const t = setTimeout(() => window.addEventListener('mousedown', onMouse), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouse);
    };
  }, [open, onClose, triggerRef]);

  if (!open) return null;

  const accent = accentColor ?? 'var(--accent)';

  return (
    <div className="fslm-panel" ref={panelRef}>
      {/* Toggle row */}
      <div className="fslm-row">
        <span className="fslm-label">{t('player.fsLyricsToggle')}</span>
        <label className="toggle-switch" aria-label={t('player.fsLyricsToggle')}>
          <input
            type="checkbox"
            checked={showLyrics}
            onChange={e => setLyrics(e.target.checked)}
          />
          <span className="toggle-track" />
        </label>
      </div>

      {/* Style selector — dimmed when lyrics are off */}
      <div className={`fslm-style-row${showLyrics ? '' : ' fslm-disabled'}`}>
        {(['rail', 'apple'] as const).map(style => (
          <button
            key={style}
            className={`fslm-style-btn${lyricsStyle === style ? ' fslm-style-active' : ''}`}
            onClick={() => setStyle(style)}
            style={lyricsStyle === style ? { borderColor: accent, color: accent, background: `color-mix(in srgb, ${accent} 14%, transparent)` } : undefined}
          >
            <span className="fslm-style-name">{t(`settings.fsLyricsStyle${style.charAt(0).toUpperCase() + style.slice(1)}` as any)}</span>
            <span className="fslm-style-desc">{t(`settings.fsLyricsStyle${style.charAt(0).toUpperCase() + style.slice(1)}Desc` as any)}</span>
          </button>
        ))}
      </div>

      <div className="fslm-arrow" />
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
  const fsLyricsStyle          = useAuthStore(s => s.fsLyricsStyle);
  const showFsArtistPortrait   = useAuthStore(s => s.showFsArtistPortrait);
  const fsPortraitDim          = useAuthStore(s => s.fsPortraitDim);
  const isAppleMode = showFullscreenLyrics && fsLyricsStyle === 'apple';

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

  // Lyrics settings popover state
  const [lyricsMenuOpen, setLyricsMenuOpen] = useState(false);
  const closeLyricsMenu = useCallback(() => setLyricsMenuOpen(false), []);
  const lyricsMenuTriggerRef = useRef<HTMLButtonElement>(null);

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
      data-lyrics={isAppleMode || undefined}
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

      {/* Layer 1 — artist portrait, right half; hidden in lyrics mode */}
      {showFsArtistPortrait && <FsPortrait url={portraitUrl} />}

      {/* Layer 2 — horizontal scrim: dark left → transparent right */}
      <div className="fs-scrim" aria-hidden="true" />

      {/* Close */}
      <button className="fs-close" onClick={onClose} aria-label={t('player.closeFullscreen')}>
        <ChevronDown size={28} />
      </button>

      {/* Lyrics: Apple Music-style (scrolling) or classic 5-line rail */}
      {showFullscreenLyrics && fsLyricsStyle === 'apple' && <FsLyricsApple currentTrack={currentTrack} />}
      {showFullscreenLyrics && fsLyricsStyle === 'apple' && <div className="fsa-fade-top"    aria-hidden="true" />}
      {showFullscreenLyrics && fsLyricsStyle === 'apple' && <div className="fsa-fade-bottom" aria-hidden="true" />}
      {showFullscreenLyrics && fsLyricsStyle === 'rail'  && <FsLyricsRail  currentTrack={currentTrack} />}

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
          <div style={{ position: 'relative', zIndex: 9 }}>
            <FsLyricsMenu open={lyricsMenuOpen} onClose={closeLyricsMenu} accentColor={dynamicAccent} triggerRef={lyricsMenuTriggerRef} />
            <button
              ref={lyricsMenuTriggerRef}
              className={`fs-btn fs-btn-sm${lyricsMenuOpen ? ' active' : ''}`}
              onClick={() => setLyricsMenuOpen(v => !v)}
              aria-label={t('player.fsLyricsToggle')}
              data-tooltip={lyricsMenuOpen ? undefined : t('player.fsLyricsToggle')}
              style={{ color: showFullscreenLyrics ? (dynamicAccent ?? 'var(--accent)') : 'rgba(255,255,255,0.35)' }}
            >
              <MicVocal size={14} />
            </button>
          </div>
        </div>

      </div>

      {/* Layer 4 — full-width seekbar, bottom edge */}
      <FsSeekbar duration={duration} />

    </div>
  );
}
