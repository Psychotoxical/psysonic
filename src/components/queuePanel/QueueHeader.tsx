import { useDeferredValue, useMemo, useSyncExternalStore } from 'react';
import { ChevronDown, ListMusic } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { usePlayerStore } from '../../store/playerStore';
import { useAuthStore } from '../../store/authStore';
import type { QueueItemRef } from '../../store/playerStoreTypes';
import type { DurationMode } from '../../utils/componentHelpers/queuePanelHelpers';
import { formatLongDuration } from '../../utils/format/formatDuration';
import { formatClockTime } from '../../utils/format/formatClockTime';
import { resolveQueueTrack } from '../../utils/library/queueTrackView';
import {
  getQueueResolverVersion,
  subscribeQueueResolver,
} from '../../utils/library/queueTrackResolver';

interface Props {
  queue: QueueItemRef[];
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
  const clockFormat = useAuthStore((s) => s.clockFormat);
  const { i18n } = useTranslation();

  // Thin-state: durations come from the resolver cache. The totals re-derive as
  // the cache fills (version) and on queue change; tracks past the cache window
  // contribute 0 until they resolve. Pure read (no cache mutation) in the memo.
  // H1 mitigation: a mass-resolve burst (queue restore, prefetch window slide)
  // bumps `version` dozens of times in one frame; useDeferredValue coalesces
  // the burst into a single low-priority commit so long queues do not block
  // the main thread on every cache tick. The aggregation itself is a single
  // pass — one loop produces both totals so a 50k-track queue costs one walk,
  // not two.
  const version = useSyncExternalStore(subscribeQueueResolver, getQueueResolverVersion);
  const deferredVersion = useDeferredValue(version);
  const { totalSecs, futureTracksDuration } = useMemo(() => {
    if (queue.length === 0) return { totalSecs: 0, futureTracksDuration: 0 };
    let total = 0;
    let future = 0;
    for (let i = 0; i < queue.length; i += 1) {
      const dur = resolveQueueTrack(queue[i]).duration || 0;
      total += dur;
      if (i > queueIndex) future += dur;
    }
    return { totalSecs: total, futureTracksDuration: future };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, queueIndex, deferredVersion]);

  const currentDuration = queue[queueIndex] ? resolveQueueTrack(queue[queueIndex]).duration : 0;
  const remainingSecs = Math.max(0, (currentDuration ?? 0) - currentTime + futureTracksDuration);

  let dur: string | null = null;
  if (queue.length > 0) {
    if (durationMode === 'total') dur = formatLongDuration(Math.floor(totalSecs));
    else if (durationMode === 'remaining') dur = `-${formatLongDuration(Math.floor(remainingSecs))}`;
    else dur = formatClockTime(Date.now() + remainingSecs * 1000, clockFormat, i18n.language);
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
