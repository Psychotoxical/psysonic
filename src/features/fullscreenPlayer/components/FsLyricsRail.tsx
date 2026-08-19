import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  getSmoothPlaybackTime,
  subscribeSmoothPlaybackTime,
  usePlayerStore,
} from '@/features/playback';
import { useAuthStore } from '@/store/authStore';
import { useLyrics, type WordLyricsLine, useWordLyricsSync } from '@/features/lyrics';
import type { LrcLine } from '@/features/lyrics';
import type { Track } from '@/lib/media/trackTypes';

// Classic 5-line rail lyrics (original "Rail" style).
// Slot height = 6vh = window.innerHeight * 0.06 — must match CSS height: 6vh.
export const FsLyricsRail = memo(function FsLyricsRail({ currentTrack }: { currentTrack: Track | null }) {
  const { syncedLines, wordLines, loading } = useLyrics(currentTrack);
  const staticOnly = useAuthStore(s => s.lyricsStaticOnly);

  const useWords  = !staticOnly && wordLines !== null && wordLines.length > 0;
  const lineSrc: LrcLine[] | null = useWords
    ? (wordLines as WordLyricsLine[]).map(l => ({ time: l.time, text: l.text }))
    : (syncedLines as LrcLine[] | null);
  const hasSynced = !staticOnly && lineSrc !== null && lineSrc.length > 0;

  const linesRef = useRef<LrcLine[]>([]);
  linesRef.current = hasSynced ? lineSrc! : [];

  // The store's currentTime is committed at 20 s / 5 s granularity, which is
  // far too coarse to pick a lyric line — the per-word highlighting in this
  // same view already runs off the interpolated position, so the rail followed
  // several seconds behind its own words. Both read the same clock now.
  const [activeIdx, setActiveIdx] = useState(-1);
  const activeIdxRef = useRef(-1);
  useEffect(() => {
    const apply = (time: number) => {
      const ls = linesRef.current;
      let idx = -1;
      for (let i = 0; i < ls.length; i++) {
        if (time >= ls[i].time) idx = i;
        else break;
      }
      if (idx === activeIdxRef.current) return;
      activeIdxRef.current = idx;
      setActiveIdx(idx);
    };
    apply(getSmoothPlaybackTime());
    return subscribeSmoothPlaybackTime(apply);
    // Same deps as the Apple style: the lines arrive asynchronously, and while
    // paused no progress event ever lands, so without these the rail would
    // stay unhighlighted until playback resumes.
  }, [hasSynced, currentTrack?.id]);

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

  const { setWordRef } = useWordLyricsSync({
    enabled: useWords,
    wordLines: useWords ? (wordLines as WordLyricsLine[]) : null,
    currentTrack,
    classPrefix: 'fsr',
  });

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
                    ref={setWordRef(i, j)}
                  >{w.text}</span>
                )) : (line.text || ' ')}
              </div>
            ))
          : lineSrc!.map((line, i) => (
              <div
                key={i}
                className={`fsr-lyric-line${i === activeIdx ? ' fsrl-active' : i < activeIdx ? ' fsrl-past' : ''}`}
                data-time={line.time}
              >
                {line.text || ' '}
              </div>
            ))}
      </div>
    </div>
  );
});
