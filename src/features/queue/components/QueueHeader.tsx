import { useDeferredValue, useMemo, useSyncExternalStore } from 'react';
import { AlignCenterVertical, ChevronDown, ListMusic, ListOrdered } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';
import type { QueueItemRef } from '@/lib/media/trackTypes';
import type { QueueDisplayMode } from '@/store/authStoreTypes';
import type { DurationMode } from '@/features/queue/utils/queuePanelHelpers';
import { formatLongDuration } from '@/lib/format/formatDuration';
import { formatClockTime } from '@/lib/format/formatClockTime';
import { resolveQueueTrack } from '@/features/playback/store/queueTrackView';
import {
  getQueueResolverVersion,
  subscribeQueueResolver,
} from '@/features/playback/store/queueTrackResolver';

interface Props {
  queue: QueueItemRef[];
  queueIndex: number;
  activePlaylist: { id: string; name: string } | null;
  isNowPlayingCollapsed: boolean;
  setIsNowPlayingCollapsed: (v: boolean) => void;
  durationMode: DurationMode;
  setDurationMode: (m: DurationMode) => void;
  queueDisplayMode: QueueDisplayMode;
  setQueueDisplayMode: (v: QueueDisplayMode) => void;
  t: TFunction;
}

export function QueueHeader({
  queue, queueIndex, activePlaylist, isNowPlayingCollapsed,
  setIsNowPlayingCollapsed, durationMode, setDurationMode,
  queueDisplayMode, setQueueDisplayMode, t,
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
  // the main thread on every cache tick.
  //
  // The O(n) walk is keyed on `queue`/`deferredVersion` only — NOT `queueIndex`.
  // A skip moves only `queueIndex`, so it must not re-walk the whole queue: that
  // synchronous O(n) pass on every track change froze the UI for seconds on very
  // large queues (#1072, and the device-switch fallback in #1090). Instead we
  // build a cumulative-duration prefix (`cumSecs[i]` = summed duration of tracks
  // [0, i)) once per queue/cache change, then derive the future total as an O(1)
  // lookup below. A 50k-track queue costs one walk per queue/cache change, zero
  // per track change.
  const version = useSyncExternalStore(subscribeQueueResolver, getQueueResolverVersion);
  const deferredVersion = useDeferredValue(version);
  const { totalSecs, cumSecs } = useMemo(() => {
    const cum = new Float64Array(queue.length + 1);
    for (let i = 0; i < queue.length; i += 1) {
      cum[i + 1] = cum[i] + (resolveQueueTrack(queue[i]).duration || 0);
    }
    return { totalSecs: cum[queue.length], cumSecs: cum };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, deferredVersion]);
  // Tracks strictly after the current index — O(1) per skip.
  const futureTracksDuration = Math.max(
    0,
    totalSecs - cumSecs[Math.min(queueIndex + 1, queue.length)],
  );

  const currentDuration = queue[queueIndex] ? resolveQueueTrack(queue[queueIndex]).duration : 0;
  const remainingSecs = Math.max(0, (currentDuration ?? 0) - currentTime + futureTracksDuration);

  let dur: string | null = null;
  if (queue.length > 0) {
    if (durationMode === 'total') dur = formatLongDuration(Math.floor(totalSecs));
    else if (durationMode === 'remaining') dur = `-${formatLongDuration(Math.floor(remainingSecs))}`;
    // React Compiler purity rule: intentional live-timestamp read at render (Date.now()); the value is allowed to differ between renders.
    // eslint-disable-next-line react-hooks/purity
    else dur = formatClockTime(Date.now() + remainingSecs * 1000, clockFormat, i18n.language);
  }

  const nextMode: DurationMode =
    durationMode === 'total' ? 'remaining' :
    durationMode === 'remaining' ? 'eta' : 'total';
  const nextTooltipKey =
    nextMode === 'total' ? 'queue.showTotal' :
    nextMode === 'remaining' ? 'queue.showRemaining' : 'queue.showEta';

  const isEta = durationMode === 'eta';

  // Cycle the panel through the three render modes; icon + title show the active
  // one, tooltip names the one a click switches to.
  const DISPLAY_MODE_CYCLE: QueueDisplayMode[] = ['queue', 'timeline', 'playlist'];
  const nextDisplayMode =
    DISPLAY_MODE_CYCLE[(DISPLAY_MODE_CYCLE.indexOf(queueDisplayMode) + 1) % DISPLAY_MODE_CYCLE.length];
  const displayModeLabel = (m: QueueDisplayMode) =>
    m === 'playlist' ? t('queue.modePlaylist') : m === 'timeline' ? t('queue.modeTimeline') : t('queue.title');
  const displayModeIcon = (m: QueueDisplayMode) =>
    m === 'playlist' ? <ListMusic size={15} /> : m === 'timeline' ? <AlignCenterVertical size={15} /> : <ListOrdered size={15} />;

  return (
    <div className="queue-header">
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "8px", minWidth: 0 }}>
          {/* Small icon button to flip the display mode without leaving the
              panel. Icon reflects the active mode; the title (next to it) and
              the tooltip name the modes. Mirrors the Settings toggle. */}
          <button
            type="button"
            className="queue-action-btn"
            onClick={() => setQueueDisplayMode(nextDisplayMode)}
            data-tooltip={displayModeLabel(nextDisplayMode)}
            aria-label={displayModeLabel(nextDisplayMode)}
            style={{ width: 24, height: 24, alignSelf: 'center', flexShrink: 0 }}
          >
            {displayModeIcon(queueDisplayMode)}
          </button>
          {/* Title doubles as the mode indicator so the panel names the active
              mode rather than always reading "Queue". */}
          <h2 style={{ fontSize: "16px", fontWeight: 700, margin: 0, flexShrink: 0 }}>
            {displayModeLabel(queueDisplayMode)}
          </h2>
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
