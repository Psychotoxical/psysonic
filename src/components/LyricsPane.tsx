import { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../store/playerStore';
import { fetchLyrics, parseLrc, LrcLine } from '../api/lrclib';
import { useTranslation } from 'react-i18next';
import type { Track } from '../store/playerStore';

interface Props {
  currentTrack: Track | null;
}

export default function LyricsPane({ currentTrack }: Props) {
  const { t } = useTranslation();

  const [loading, setLoading]         = useState(false);
  const [syncedLines, setSyncedLines]   = useState<LrcLine[] | null>(null);
  const [plainLyrics, setPlainLyrics]   = useState<string | null>(null);
  const [notFound, setNotFound]         = useState(false);
  const [fetchedFor, setFetchedFor]     = useState<string | null>(null);

  const hasSynced  = syncedLines !== null && syncedLines.length > 0;
  const currentTime = usePlayerStore(s => hasSynced ? s.currentTime : 0);

  const lineRefs   = useRef<(HTMLDivElement | null)[]>([]);
  const prevActive = useRef(-1);

  useEffect(() => {
    if (!currentTrack || currentTrack.id === fetchedFor) return;
    let cancelled = false;
    setSyncedLines(null);
    setPlainLyrics(null);
    setNotFound(false);
    setLoading(true);
    lineRefs.current = [];
    prevActive.current = -1;

    fetchLyrics(
      currentTrack.artist ?? '',
      currentTrack.title,
      currentTrack.album ?? '',
      currentTrack.duration ?? 0,
    ).then(result => {
      if (cancelled) return;
      setLoading(false);
      setFetchedFor(currentTrack.id);
      if (!result || (!result.syncedLyrics && !result.plainLyrics)) {
        setNotFound(true);
        return;
      }
      if (result.syncedLyrics) {
        const lines = parseLrc(result.syncedLyrics);
        setSyncedLines(lines.length > 0 ? lines : null);
      }
      setPlainLyrics(result.plainLyrics);
    }).catch(() => {
      if (!cancelled) { setLoading(false); setNotFound(true); }
    });
    return () => { cancelled = true; };
  }, [currentTrack?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset when track changes
  useEffect(() => {
    setFetchedFor(null);
  }, [currentTrack?.id]);

  const activeIdx = hasSynced
    ? syncedLines!.reduce((acc, line, i) => (currentTime >= line.time ? i : acc), -1)
    : -1;

  useEffect(() => {
    if (activeIdx < 0 || activeIdx === prevActive.current) return;
    prevActive.current = activeIdx;
    lineRefs.current[activeIdx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeIdx]);

  if (!currentTrack) {
    return (
      <div className="lyrics-pane-empty">
        <p className="lyrics-status">{t('player.lyricsNotFound')}</p>
      </div>
    );
  }

  return (
    <div className="lyrics-pane">
      {loading && <p className="lyrics-status">{t('player.lyricsLoading')}</p>}
      {notFound && !loading && <p className="lyrics-status">{t('player.lyricsNotFound')}</p>}
      {hasSynced && (
        <div className="lyrics-synced">
          {syncedLines!.map((line, i) => (
            <div
              key={i}
              ref={el => { lineRefs.current[i] = el; }}
              className={`lyrics-line${i === activeIdx ? ' active' : ''}`}
            >
              {line.text || '\u00A0'}
            </div>
          ))}
        </div>
      )}
      {!hasSynced && plainLyrics && (
        <div className="lyrics-plain">
          {plainLyrics.split('\n').map((line, i) => (
            <p key={i} className="lyrics-plain-line">{line || '\u00A0'}</p>
          ))}
        </div>
      )}
    </div>
  );
}
