import React, { memo, useCallback, useEffect, useRef } from 'react';
import { usePlayerStore } from '../../store/playerStore';
import { useAuthStore } from '../../store/authStore';
import { useLyrics, type WordLyricsLine } from '../../hooks/useLyrics';
import { useWordLyricsSync } from '../../hooks/useWordLyricsSync';
import type { LrcLine } from '../../api/lrclib';
import type { Track } from '../../store/playerStoreTypes';

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
