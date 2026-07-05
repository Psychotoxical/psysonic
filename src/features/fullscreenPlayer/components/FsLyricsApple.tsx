import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import { useLyrics, type WordLyricsLine } from '@/features/lyrics';
import { useWordLyricsSync } from '@/features/lyrics';
import { getPlaybackProgressSnapshot, subscribePlaybackProgress } from '@/features/playback/store/playbackProgress';
import type { LrcLine } from '@/features/lyrics';
import type { Track } from '@/lib/media/trackTypes';
import { EaseScroller, targetForFraction } from '@/lib/dom/easeScroll';

// Fullscreen synced lyrics.
// Full-screen scrollable list. The active line auto-scrolls following the
// "Lyrics scroll style" setting: 'apple' anchors it ~35% from the top, 'classic'
// centres it. Word-sync runs imperatively (no React re-renders on every time tick).
// User scroll pauses auto-scroll for 4 s then resumes.
export const FsLyricsApple = memo(function FsLyricsApple({ currentTrack }: { currentTrack: Track | null }) {
  const { syncedLines, wordLines, plainLyrics, loading } = useLyrics(currentTrack);
  const staticOnly = useAuthStore(s => s.lyricsStaticOnly);
  const sidebarLyricsStyle = useAuthStore(s => s.sidebarLyricsStyle);

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
    apply(getPlaybackProgressSnapshot().currentTime);
    return subscribePlaybackProgress(s => apply(s.currentTime));
  }, [hasSynced, currentTrack?.id]);

  // Scroll the active line into view, honouring the "Lyrics scroll style" setting
  // (same as the sidebar LyricsPane): 'apple' ease-scrolls to ~35% from the top,
  // 'classic' centres the active line via native smooth scrollIntoView.
  useEffect(() => {
    if (activeIdx < 0 || isUserScroll.current) return;
    const el  = lineRefs.current[activeIdx];
    const box = containerRef.current;
    if (!el || !box || !scrollerRef.current) return;
    if (sidebarLyricsStyle === 'apple') {
      scrollerRef.current.scrollTo(targetForFraction(box, el, 0.35));
    } else {
      scrollerRef.current.stop();
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeIdx, sidebarLyricsStyle]);

  const { setWordRef } = useWordLyricsSync({
    enabled: useWords,
    wordLines: useWords ? (wordLines as WordLyricsLine[]) : null,
    currentTrack,
    classPrefix: 'fsa',
  });

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
                      ref={setWordRef(i, j)}
                    >{w.text}</span>
                  ))
                : (line.text || ' ')}
            </div>
          ))
        : lineSrc!.map((line, i) => (
            <div
              key={i}
              ref={el => { lineRefs.current[i] = el; }}
              className={`fsa-lyric-line${i === activeIdx ? ' fsal-active' : i < activeIdx ? ' fsal-past' : ''}`}
              data-time={line.time}
            >
              {line.text || ' '}
            </div>
          ))
      )}

      {!hasSynced && plainLyrics && (
        <div className="fsa-plain-lyrics">
          {plainLyrics.split('\n').map((line, i) => (
            <p key={i} className="fsa-plain-line">{line || ' '}</p>
          ))}
        </div>
      )}

      <div className="fsa-lyrics-bottom-pad" />
    </div>
  );
});
