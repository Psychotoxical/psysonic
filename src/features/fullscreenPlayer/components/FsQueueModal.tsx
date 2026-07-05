import { memo, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import type { Track } from '@/lib/media/trackTypes';
import { resolveQueueTrack } from '@/features/playback/store/queueTrackView';
import {
  getQueueResolverVersion,
  subscribeQueueResolver,
  resolveBatch,
} from '@/features/playback/store/queueTrackResolver';
import { formatTrackTime } from '@/lib/format/formatDuration';

interface Props {
  onClose: () => void;
}

/**
 * Semi-transparent "Up next" overlay for the fullscreen player — lists the
 * upcoming queue (no blur, in keeping with the static player). Clicking a row
 * jumps to that queue item (same-queue jump as the queue panel).
 */
export const FsQueueModal = memo(function FsQueueModal({ onClose }: Props) {
  const { t } = useTranslation();
  const queueItems = usePlayerStore(s => s.queueItems);
  const queueIndex = usePlayerStore(s => s.queueIndex);
  const playTrack = usePlayerStore(s => s.playTrack);
  // Re-resolve as the resolver cache fills.
  const version = useSyncExternalStore(subscribeQueueResolver, getQueueResolverVersion);

  const upcoming = useMemo(() => {
    const out: { track: Track; absIdx: number }[] = [];
    for (let i = queueIndex + 1; i < queueItems.length; i++) {
      const ref = queueItems[i];
      if (ref) out.push({ track: resolveQueueTrack(ref), absIdx: i });
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueItems, queueIndex, version]);

  // This overlay renders the whole "up next" list (not virtualized), but the
  // resolver bridge only warms a window around the playing index — so rows past
  // that window would show the '…' placeholder. Resolve every upcoming ref shown
  // here; resolveBatch dedups against cache/in-flight.
  useEffect(() => {
    const refs = [];
    for (let i = queueIndex + 1; i < queueItems.length; i++) {
      const ref = queueItems[i];
      if (ref) refs.push({ serverId: ref.serverId, trackId: ref.trackId });
    }
    if (refs.length > 0) void resolveBatch(refs);
  }, [queueItems, queueIndex]);

  return (
    <div
      className="fsq-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t('player.fsUpNext')}
    >
      <div className="fsq-panel" onClick={e => e.stopPropagation()}>
        <div className="fsq-header">
          <span className="fsq-title">{t('player.fsUpNext')}</span>
          <button className="fsq-close" onClick={onClose} aria-label={t('common.close')}>
            <X size={18} />
          </button>
        </div>
        <div className="fsq-list">
          {upcoming.length === 0 ? (
            <div className="fsq-empty">{t('player.fsQueueEmpty')}</div>
          ) : (
            upcoming.map(({ track, absIdx }) => (
              <button
                key={`${track.id}:${absIdx}`}
                className="fsq-item"
                onClick={() => {
                  playTrack(track, undefined, undefined, undefined, absIdx);
                  onClose();
                }}
              >
                <span className="fsq-item-pos">{absIdx + 1}</span>
                <span className="fsq-item-info">
                  <span className="fsq-item-title">{track.title}</span>
                  <span className="fsq-item-artist">{track.artist}</span>
                </span>
                <span className="fsq-item-dur">{formatTrackTime(track.duration ?? 0)}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
});
