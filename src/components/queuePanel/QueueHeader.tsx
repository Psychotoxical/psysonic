import { useMemo } from 'react';
import { ChevronDown, ListMusic } from 'lucide-react';
import type { TFunction } from 'i18next';
import { usePlayerStore } from '../../store/playerStore';
import type { Track } from '../../store/playerStoreTypes';
import type { DurationMode } from '../../utils/componentHelpers/queuePanelHelpers';

interface Props {
  queue: Track[];
  queueIndex: number;
  activePlaylist: { id: string; name: string } | null;
  isNowPlayingCollapsed: boolean;
  setIsNowPlayingCollapsed: (v: boolean) => void;
  durationMode: DurationMode;
  setDurationMode: (m: DurationMode) => void;
  t: TFunction;
}

export function QueueHeader({
  queue, queueIndex, activePlaylist, isNowPlayingCollapsed,
  setIsNowPlayingCollapsed, durationMode, setDurationMode, t,
}: Props) {
  const currentTime = usePlayerStore((s) => Math.floor(s.currentTime / 30) * 30);
  const isPlaying = usePlayerStore((s) => s.isPlaying);

  const totalSecs = useMemo(() =>
    queue.reduce((acc: number, track: Track) => acc + (track.duration || 0), 0),
    [queue]
  );
  const futureTracksDuration = useMemo(() =>
    queue.slice(queueIndex + 1).reduce((acc: number, track: Track) => acc + (track.duration || 0), 0),
    [queue, queueIndex]
  );

  const remainingSecs = Math.max(0, (queue[queueIndex]?.duration ?? 0) - currentTime + futureTracksDuration);

  const fmt = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}` : `${m}:${s.toString().padStart(2, "0")}`;
  };
  const fmtEta = (secs: number) => {
    const finishTime = new Date(Date.now() + secs * 1000);
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(finishTime);
  };

  let dur: string | null = null;
  if (queue.length > 0) {
    if (durationMode === 'total') dur = fmt(Math.floor(totalSecs));
    else if (durationMode === 'remaining') dur = `-${fmt(Math.floor(remainingSecs))}`;
    else dur = fmtEta(remainingSecs);
  }

  const nextMode: DurationMode =
    durationMode === 'total' ? 'remaining' :
    durationMode === 'remaining' ? 'eta' : 'total';
  const nextTooltipKey =
    nextMode === 'total' ? 'queue.showTotal' :
    nextMode === 'remaining' ? 'queue.showRemaining' : 'queue.showEta';

  const isEta = durationMode === 'eta';

  return (
    <div className="queue-header">
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "8px", minWidth: 0 }}>
          <h2 style={{ fontSize: "16px", fontWeight: 700, margin: 0, flexShrink: 0 }}>{t("queue.title")}</h2>
          {queue.length > 0 && (
            <span style={{ fontSize: "13px", color: "var(--text-muted)", whiteSpace: "nowrap", userSelect: "none" }}>
              ({queueIndex + 1}/{queue.length})
            </span>
          )}
          {dur !== null && (
            <span
              onClick={() => setDurationMode(nextMode)}
              data-tooltip={t(nextTooltipKey)}
              style={{
                fontSize: "13px",
                color: isEta ? (isPlaying ? "var(--accent)" : "var(--text-muted)") : "var(--accent)",
                opacity: isEta && !isPlaying ? 0.5 : 1,
                whiteSpace: "nowrap",
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              · {dur}
            </span>
          )}
        </div>
        {activePlaylist && (
          <div className="truncate" style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px", display: "flex", alignItems: "center", gap: "4px" }}>
            <ListMusic size={10} style={{ flexShrink: 0 }} />
            <span className="truncate">{activePlaylist.name}</span>
          </div>
        )}
      </div>
      <button
        className="queue-action-btn"
        onClick={() => queue.length > 0 && setIsNowPlayingCollapsed(!isNowPlayingCollapsed)}
        disabled={queue.length === 0}
        data-tooltip={queue.length === 0 ? t('queue.emptyQueue') : (isNowPlayingCollapsed ? t('queue.showNowPlaying') : t('queue.hideNowPlaying'))}
        aria-label={queue.length === 0 ? t('queue.emptyQueue') : (isNowPlayingCollapsed ? t('queue.showNowPlaying') : t('queue.hideNowPlaying'))}
        aria-expanded={!isNowPlayingCollapsed}
        style={{ marginLeft: '8px', opacity: queue.length === 0 ? 0.3 : 1, cursor: queue.length === 0 ? 'not-allowed' : 'pointer' }}
      >
        <ChevronDown size={18} style={{ transform: isNowPlayingCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.2s ease' }} />
      </button>
    </div>
  );
}
