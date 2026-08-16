import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TFunction } from 'i18next';
import { BadgeCheck, SendHorizontal } from 'lucide-react';
import { offlineActionPolicy } from '@/features/offline/utils/offlineActionPolicy';
import { useOfflineBrowseActive } from '@/features/offline/utils/offlineBrowseMode';
import { PlaybackTime } from '@/features/playback/components/playerBar/PlaybackClock';
import { usePlayerBarAnchoredPopover } from '@/features/playback/hooks/usePlayerBarAnchoredPopover';
import { prepareTransientUiOpen } from '@/lib/dom/transientUi';
import {
  getPlaybackProgressSnapshot,
  subscribePlaybackProgress,
} from '@/features/playback/store/playbackProgress';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { useAuthStore } from '@/store/authStore';

const POPOVER_WIDTH = 220;
const HOVER_OPEN_MS = 500;
const HOVER_CLOSE_MS = 150;

interface Props {
  minuteFieldWidth: number;
  t: TFunction;
}

function useScrobbleStatusState(t: TFunction) {
  const [heardPercent, setHeardPercent] = useState(() =>
    Math.round(getPlaybackProgressSnapshot().progress * 100),
  );
  const scrobbled = usePlayerStore(s => s.scrobbled);
  const hasTrack = usePlayerStore(s => s.currentTrack != null);
  const forceScrobble = usePlayerStore(s => s.forceScrobbleCurrentTrack);
  const threshold = useAuthStore(s => s.scrobbleThresholdPercent);
  const offline = useOfflineBrowseActive();
  const canScrobble = offlineActionPolicy('playerBar', offline).canScrobble;

  useEffect(() => {
    const sync = () => setHeardPercent(Math.round(getPlaybackProgressSnapshot().progress * 100));
    sync();
    return subscribePlaybackProgress(sync);
  }, []);

  const blockedReason = !hasTrack
    ? t('player.scrobbleUnavailable')
    : !canScrobble
      ? t('player.scrobbleOffline')
      : scrobbled
        ? t('player.scrobbleAlreadySent')
        : null;

  return {
    heardPercent,
    threshold,
    scrobbled,
    blockedReason,
    forceScrobble,
  };
}

function ScrobbleStatusContent({ t }: { t: TFunction }) {
  const { heardPercent, threshold, blockedReason, forceScrobble } = useScrobbleStatusState(t);
  return (
    <>
      <div className="player-scrobble-popover__progress">
        {t('player.scrobbleProgress', { current: heardPercent, threshold })}
      </div>
      {blockedReason == null ? (
        <button
          type="button"
          className="player-scrobble-popover__force"
          onClick={() => {
            forceScrobble();
          }}
        >
          <SendHorizontal size={14} aria-hidden />
          {t('player.forceScrobble')}
        </button>
      ) : (
        <div className="player-scrobble-popover__blocked">{blockedReason}</div>
      )}
    </>
  );
}

export function ScrobbleStatus({ minuteFieldWidth, t }: Props) {
  const { open, setOpen, popStyle, btnRef, popRef } = usePlayerBarAnchoredPopover(POPOVER_WIDTH);
  const hoverTimer = useRef<number | null>(null);

  const clearHoverTimer = () => {
    if (hoverTimer.current != null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };

  const scheduleOpen = useCallback(() => {
    clearHoverTimer();
    hoverTimer.current = window.setTimeout(() => {
      prepareTransientUiOpen();
      setOpen(true);
    }, HOVER_OPEN_MS);
  }, [setOpen]);

  const scheduleClose = useCallback(() => {
    clearHoverTimer();
    hoverTimer.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_MS);
  }, [setOpen]);

  useEffect(() => () => clearHoverTimer(), []);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`player-time player-time-scrobble${open ? ' is-open' : ''}`}
        aria-label={t('player.scrobbleStatus')}
        aria-expanded={open}
        aria-haspopup="dialog"
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onFocus={() => {
          prepareTransientUiOpen();
          setOpen(true);
        }}
        onClick={() => {
          if (!open) prepareTransientUiOpen();
          setOpen(v => !v);
        }}
      >
        <PlaybackTime minuteFieldWidth={minuteFieldWidth} />
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          className="player-scrobble-popover"
          role="dialog"
          aria-label={t('player.scrobbleStatus')}
          style={popStyle}
          onMouseEnter={clearHoverTimer}
          onMouseLeave={scheduleClose}
        >
          <ScrobbleStatusContent t={t} />
        </div>,
        document.body,
      )}
    </>
  );
}

export function ScrobbleActionButton({
  t,
  className,
  activeClassName = 'active',
  iconSize = 15,
}: {
  t: TFunction;
  className: string;
  activeClassName?: string;
  iconSize?: number;
}) {
  const { open, toggleOpen, popStyle, btnRef, popRef } = usePlayerBarAnchoredPopover(POPOVER_WIDTH);
  const { scrobbled, blockedReason } = useScrobbleStatusState(t);
  const Icon = scrobbled ? BadgeCheck : SendHorizontal;
  const tooltip = scrobbled ? t('player.scrobbleAlreadySent') : t('player.forceScrobble');

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`${className}${scrobbled ? ` ${activeClassName}` : ''}`}
        onClick={toggleOpen}
        aria-label={tooltip}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-disabled={blockedReason != null && !scrobbled}
        data-tooltip={open ? undefined : tooltip}
      >
        <Icon size={iconSize} aria-hidden />
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          className="player-scrobble-popover"
          role="dialog"
          aria-label={t('player.scrobbleStatus')}
          style={popStyle}
        >
          <ScrobbleStatusContent t={t} />
        </div>,
        document.body,
      )}
    </>
  );
}
