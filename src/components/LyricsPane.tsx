import { getPlaybackProgressSnapshot, subscribePlaybackProgress } from '../store/playbackProgress';
import { useEffect, useRef, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { usePlayerStore } from '../store/playerStore';
import type { LrcLine } from '../api/lrclib';
import { useLyrics, type WordLyricsLine } from '../hooks/useLyrics';
import { useAuthStore } from '../store/authStore';
import { useTranslation } from 'react-i18next';
import type { Track } from '../store/playerStoreTypes';
import { EaseScroller, targetForFraction } from '../utils/ui/easeScroll';
import OverlayScrollArea from './OverlayScrollArea';

interface Props {
  currentTrack: Track | null;
}

/**
 * Apple Music-style scroll: active line scrolls to ~35% from top.
 * User scrolling pauses auto-scroll for 4 s then resumes.
 * Word-sync and line highlighting are imperative (no React re-renders per tick).
 */
export default function LyricsPane({ currentTrack }: Props) {
  const { t } = useTranslation();

  const { syncedLines, wordLines, plainLyrics, source, loading, notFound } = useLyrics(currentTrack);
  const { staticOnly, sidebarLyricsStyle } = useAuthStore(useShallow(s => ({
    staticOnly: s.lyricsStaticOnly,
    sidebarLyricsStyle: s.sidebarLyricsStyle,
  })));

  const useWords  = !staticOnly && wordLines !== null && wordLines.length > 0;
  const hasSynced = !staticOnly && !useWords && syncedLines !== null && syncedLines.length > 0;

  const seek     = usePlayerStore(s => s.seek);
  const duration = usePlayerStore(s => s.currentTrack?.duration ?? 0);

  const containerRef  = useRef<HTMLDivElement | null>(null);
  const scrollerRef   = useRef<EaseScroller | null>(null);
  const lineRefs      = useRef<(HTMLDivElement | null)[]>([]);
  const wordRefs      = useRef<HTMLSpanElement[][]>([]);
  const prevActive    = useRef({ line: -1, word: -1 });
  const prevTrackId   = useRef<string | null | undefined>(undefined);
  const isUserScroll  = useRef(false);
  const scrollTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    scrollerRef.current?.stop();
    scrollerRef.current = el ? new EaseScroller(el) : null;
  }, []);

  const handleUserScroll = useCallback(() => {
    scrollerRef.current?.stop();
    isUserScroll.current = true;
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => { isUserScroll.current = false; }, 4000);
  }, []);

  const scrollToLine = useCallback((el: HTMLDivElement) => {
    if (isUserScroll.current) return;
    const container = containerRef.current;
    if (!container) return;
    if (sidebarLyricsStyle === 'apple' && scrollerRef.current) {
      scrollerRef.current.scrollTo(targetForFraction(container, el, 0.35));
    } else {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [sidebarLyricsStyle]);

  // Reset refs on actual track change. Skip the initial mount so we don't wipe
  // the callback-refs that the commit phase just populated — that would leave
  // the tracker effect with an empty lineRefs and freeze the highlight.
  useEffect(() => {
    const id = currentTrack?.id ?? null;
    if (prevTrackId.current !== undefined && prevTrackId.current !== id) {
      lineRefs.current = [];
      wordRefs.current = [];
      prevActive.current = { line: -1, word: -1 };
      scrollerRef.current?.jump(0);
    }
    prevTrackId.current = id;
  }, [currentTrack?.id]);

  // Imperative tracker — subscribes directly to the store, zero React re-renders per tick.
  useEffect(() => {
    if (!useWords && !hasSynced) return;

    const apply = (time: number) => {
      const lines = useWords ? (wordLines as WordLyricsLine[]) : (syncedLines as LrcLine[]);
      let lineIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (time >= lines[i].time) lineIdx = i;
        else break;
      }

      let wordIdx = -1;
      if (useWords && lineIdx >= 0) {
        const words = (wordLines as WordLyricsLine[])[lineIdx].words;
        for (let j = 0; j < words.length; j++) {
          if (time >= words[j].time) wordIdx = j;
          else break;
        }
      }

      const prev = prevActive.current;
      if (prev.line === lineIdx && prev.word === wordIdx) return;

      if (prev.line !== lineIdx) {
        if (prev.line >= 0) {
          const el = lineRefs.current[prev.line];
          if (el) el.className = lineClass(prev.line, lineIdx);
        }
        if (lineIdx >= 0) {
          const el = lineRefs.current[lineIdx];
          if (el) {
            el.className = lineClass(lineIdx, lineIdx);
            scrollToLine(el);
          }
        }
        if (useWords && prev.line >= 0 && wordRefs.current[prev.line]) {
          for (const w of wordRefs.current[prev.line]) w.className = 'lyrics-word';
        }
      }

      if (useWords && lineIdx >= 0 && wordRefs.current[lineIdx]) {
        const ws = wordRefs.current[lineIdx];
        for (let j = 0; j < ws.length; j++) {
          ws[j].className = j < wordIdx ? 'lyrics-word played'
                          : j === wordIdx ? 'lyrics-word active'
                          : 'lyrics-word';
        }
      }

      prevActive.current = { line: lineIdx, word: wordIdx };
    };

    apply(getPlaybackProgressSnapshot().currentTime);
    return subscribePlaybackProgress(s => apply(s.currentTime));
  }, [useWords, hasSynced, wordLines, syncedLines, scrollToLine]);

  if (!currentTrack) {
    return (
      <div className="lyrics-pane-empty">
        <p className="lyrics-status">{t('player.lyricsNotFound')}</p>
      </div>
    );
  }

  const sourceLabel = source === 'server'
    ? t('player.lyricsSourceServer')
    : source === 'lrclib'
      ? t('player.lyricsSourceLrclib')
      : source === 'netease'
        ? t('player.lyricsSourceNetease')
        : source === 'lyricsplus'
          ? t('player.lyricsSourceLyricsplus')
          : null;

  const renderAsStatic = staticOnly && (
    (syncedLines !== null && syncedLines.length > 0) ||
    (wordLines !== null && wordLines.length > 0)
  );

  return (
    <OverlayScrollArea
      className="lyrics-pane"
      viewportClassName="lyrics-pane__viewport"
      viewportRef={setContainerRef}
      measureDeps={[
        currentTrack?.id,
        loading,
        notFound,
        source,
        useWords,
        hasSynced,
        staticOnly,
        sidebarLyricsStyle,
        plainLyrics?.length ?? 0,
        syncedLines?.length ?? 0,
        wordLines?.length ?? 0,
      ]}
      railInset="panel"
      viewportOnWheel={handleUserScroll}
      viewportOnTouchMove={handleUserScroll}
    >
      {loading && <p className="lyrics-status">{t('player.lyricsLoading')}</p>}
      {notFound && !loading && <p className="lyrics-status">{t('player.lyricsNotFound')}</p>}

      {useWords && (
        <div className="lyrics-synced lyrics-word-synced">
          {(wordLines as WordLyricsLine[]).map((line, i) => (
            <div
              key={i}
              ref={el => { lineRefs.current[i] = el; }}
              className="lyrics-line"
              onClick={() => { if (duration > 0) seek(line.time / duration); }}
              style={{ cursor: 'pointer' }}
            >
              {line.words.length > 0 ? line.words.map((w, j) => (
                <span
                  key={j}
                  className="lyrics-word"
                  ref={el => {
                    if (!wordRefs.current[i]) wordRefs.current[i] = [];
                    if (el) wordRefs.current[i][j] = el;
                  }}
                >
                  {w.text}
                </span>
              )) : (line.text || '\u00A0')}
            </div>
          ))}
        </div>
      )}

      {hasSynced && !useWords && (
        <div className="lyrics-synced">
          {(syncedLines as LrcLine[]).map((line, i) => (
            <div
              key={i}
              ref={el => { lineRefs.current[i] = el; }}
              className="lyrics-line"
              onClick={() => { if (duration > 0) seek(line.time / duration); }}
              style={{ cursor: 'pointer' }}
            >
              {line.text || '\u00A0'}
            </div>
          ))}
        </div>
      )}

      {renderAsStatic && (
        <div className="lyrics-plain">
          {((syncedLines ?? []).length > 0
            ? (syncedLines as LrcLine[]).map(l => l.text)
            : (wordLines as WordLyricsLine[]).map(l => l.text)
          ).map((text, i) => (
            <p key={i} className="lyrics-plain-line">{text || '\u00A0'}</p>
          ))}
        </div>
      )}

      {!renderAsStatic && !useWords && !hasSynced && plainLyrics && (
        <div className="lyrics-plain">
          {plainLyrics.split('\n').map((line, i) => (
            <p key={i} className="lyrics-plain-line">{line || '\u00A0'}</p>
          ))}
        </div>
      )}

      {sourceLabel && !loading && !notFound && (
        <p className="lyrics-source">{sourceLabel}</p>
      )}
    </OverlayScrollArea>
  );
}

function lineClass(i: number, active: number): string {
  const base = 'lyrics-line';
  if (i > active) return base;
  if (i < active) return `${base} completed`;
  return `${base} active`;
}
