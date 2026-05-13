import { useEffect, useRef } from 'react';
import { getPlaybackProgressSnapshot, subscribePlaybackProgress } from '../store/playbackProgress';
import type { Track } from '../store/playerStoreTypes';
import type { WordLyricsLine } from './useLyrics';

interface Args {
  enabled: boolean;
  wordLines: WordLyricsLine[] | null;
  currentTrack: Track | null;
  /** CSS class prefix — `fsa` for Apple Music view, `fsr` for rail view. */
  classPrefix: 'fsa' | 'fsr';
}

/** Imperative word-sync DOM updates — toggles the per-word `<span>` classes
 *  (`<prefix>-lyric-word`, ` played`, ` active`) from a single playback-progress
 *  subscription without re-rendering React on every tick. Returns the ref array
 *  the consumer attaches to each word span. */
export function useWordLyricsSync({ enabled, wordLines, currentTrack, classPrefix }: Args) {
  const wordRefs = useRef<HTMLSpanElement[][]>([]);
  const prevWord = useRef<{ line: number; word: number }>({ line: -1, word: -1 });

  useEffect(() => {
    wordRefs.current = [];
    prevWord.current = { line: -1, word: -1 };
  }, [currentTrack?.id, enabled]);

  useEffect(() => {
    if (!enabled || !wordLines) return;
    const lines = wordLines;
    const baseClass = `${classPrefix}-lyric-word`;
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
      if (prev.line !== li && prev.line >= 0 && wordRefs.current[prev.line]) {
        for (const w of wordRefs.current[prev.line]) w.className = baseClass;
      }
      if (li >= 0 && wordRefs.current[li]) {
        const ws = wordRefs.current[li];
        for (let j = 0; j < ws.length; j++) {
          ws[j].className = j < wi ? `${baseClass} played` : j === wi ? `${baseClass} active` : baseClass;
        }
      }
      prevWord.current = { line: li, word: wi };
    };
    apply(getPlaybackProgressSnapshot().currentTime);
    return subscribePlaybackProgress(s => apply(s.currentTime));
  }, [enabled, wordLines, classPrefix]);

  const setWordRef = (lineIdx: number, wordIdx: number) => (el: HTMLSpanElement | null) => {
    if (!wordRefs.current[lineIdx]) wordRefs.current[lineIdx] = [];
    if (el) wordRefs.current[lineIdx][wordIdx] = el;
  };

  return { setWordRef };
}
