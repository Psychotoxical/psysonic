import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TFunction } from 'i18next';
import { BadgeCheck, SendHorizontal } from 'lucide-react';
import { offlineActionPolicy, useOfflineBrowseActive } from '@/features/offline';
import { usePlayerBarAnchoredPopover } from '@/features/playback/hooks/usePlayerBarAnchoredPopover';
import {
  getPlaybackProgressSnapshot,
  subscribePlaybackProgress,
} from '@/features/playback/store/playbackProgress';
import { forceScrobbleCurrentTrack } from '@/features/playback/store/scrobbleActions';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { usePreviewStore } from '@/features/playback/store/previewStore';
import { useAuthStore } from '@/store/authStore';

const POPOVER_WIDTH = 220;

function useScrobbleStatusState(t: TFunction, trackProgress: boolean) {
  const [heardPercent, setHeardPercent] = useState(() =>
    Math.round(getPlaybackProgressSnapshot().progress * 100),
  );
  const scrobbled = usePlayerStore(s => s.scrobbled);
  const hasTrack = usePlayerStore(s => s.currentTrack != null);
  const hasRadio = usePlayerStore(s => s.currentRadio != null);
  const previewing = usePreviewStore(s => s.previewingId != null);
  const threshold = useAuthStore(s => s.scrobbleThresholdPercent);
  const offline = useOfflineBrowseActive();
  const canScrobble = offlineActionPolicy('playerBar', offline).canScrobble;

  useEffect(() => {
    if (!trackProgress) return;
    const sync = () => setHeardPercent(Math.round(getPlaybackProgressSnapshot().progress * 100));
    sync();
    return subscribePlaybackProgress(sync);
  }, [trackProgress]);

  const blockedReason = hasRadio
    ? t('player.scrobbleRadio')
    : !hasTrack
      ? t('player.scrobbleUnavailable')
      : previewing
        ? t('player.scrobblePreview')
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
    canScrobble,
  };
}

function ScrobbleStatusContent({
  t,
  forceButtonRef,
  blockedStatusRef,
  onForce,
}: {
  t: TFunction;
  forceButtonRef: React.RefObject<HTMLButtonElement | null>;
  blockedStatusRef: React.RefObject<HTMLDivElement | null>;
  onForce: () => void;
}) {
  const { heardPercent, threshold, blockedReason } = useScrobbleStatusState(t, true);
  return (
    <>
      <div className="player-scrobble-popover__progress">
        {t('player.scrobbleProgress', { current: heardPercent, threshold })}
      </div>
      {blockedReason == null ? (
        <button
          ref={forceButtonRef}
          type="button"
          className="player-scrobble-popover__force"
          onClick={onForce}
        >
          <SendHorizontal size={14} aria-hidden />
          {t('player.forceScrobble')}
        </button>
      ) : (
        <div
          ref={blockedStatusRef}
          className="player-scrobble-popover__blocked"
          tabIndex={-1}
        >
          {blockedReason}
        </div>
      )}
    </>
  );
}

interface ScrobbleActionButtonProps {
  t: TFunction;
  className: string;
  activeClassName?: string;
  iconSize?: number;
  direct?: boolean;
  onDirectAction?: () => void;
}

function EnabledScrobbleActionButton({
  t,
  className,
  activeClassName = 'active',
  iconSize = 15,
  direct = false,
  onDirectAction,
}: ScrobbleActionButtonProps) {
  const { open, setOpen, toggleOpen, popStyle, btnRef, popRef } =
    usePlayerBarAnchoredPopover(POPOVER_WIDTH);
  const forceButtonRef = useRef<HTMLButtonElement>(null);
  const blockedStatusRef = useRef<HTMLDivElement>(null);
  const { scrobbled, blockedReason, canScrobble } = useScrobbleStatusState(t, false);
  const Icon = scrobbled ? BadgeCheck : SendHorizontal;
  const tooltip = blockedReason
    ?? (scrobbled ? t('player.scrobbleAlreadySent') : t('player.forceScrobble'));

  useEffect(() => {
    if (open) (forceButtonRef.current ?? blockedStatusRef.current)?.focus();
  }, [blockedReason, open]);

  const force = () => {
    if (blockedReason == null) forceScrobbleCurrentTrack(canScrobble);
  };

  if (direct) {
    return (
      <button
        ref={btnRef}
        type="button"
        className={`${className}${scrobbled ? ` ${activeClassName}` : ''}`}
        onClick={() => {
          if (blockedReason != null) return;
          force();
          onDirectAction?.();
        }}
        aria-label={tooltip}
        aria-disabled={blockedReason != null}
        data-tooltip={tooltip}
      >
        <Icon size={iconSize} aria-hidden />
      </button>
    );
  }

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
          onKeyDown={(event) => {
            if (event.key !== 'Tab') return;
            event.preventDefault();
            (forceButtonRef.current ?? blockedStatusRef.current)?.focus();
          }}
        >
          <ScrobbleStatusContent
            t={t}
            forceButtonRef={forceButtonRef}
            blockedStatusRef={blockedStatusRef}
            onForce={() => {
              force();
              setOpen(false);
              btnRef.current?.focus();
            }}
          />
        </div>,
        document.body,
      )}
    </>
  );
}

export function ScrobbleActionButton(props: ScrobbleActionButtonProps) {
  const enabled = useAuthStore(s => s.forceScrobbleEnabled);
  if (!enabled) return null;
  return <EnabledScrobbleActionButton {...props} />;
}
