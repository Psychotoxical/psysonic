import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePlayerStore } from '../store/playerStore';
import { useShallow } from 'zustand/react/shallow';

import type { TFunction } from 'i18next';
import { formatPlaybackScheduleRemaining } from '../utils/playbackScheduleFormat';

/** One tap = schedule; custom minutes still covers any duration. */
const PRESET_SECONDS = [30, 60, 120, 300, 600, 900, 1800, 3600] as const;

function formatPresetLabel(seconds: number, t: TFunction): string {
  if (seconds < 60) return t('player.delayFmtSec', { n: seconds });
  if (seconds < 3600) return t('player.delayFmtMin', { n: seconds / 60 });
  return t('player.delayFmtHr', { n: seconds / 3600 });
}

function computeAnchoredPanelStyle(anchorEl: HTMLElement): React.CSSProperties {
  const ar = anchorEl.getBoundingClientRect();
  const mw = Math.min(360, Math.max(200, window.innerWidth - 32));
  let left = ar.left + ar.width / 2 - mw / 2;
  const pad = 12;
  left = Math.max(pad, Math.min(left, window.innerWidth - mw - pad));
  const gap = 10;
  return {
    position: 'fixed',
    left,
    bottom: window.innerHeight - ar.top + gap,
    width: mw,
    maxWidth: 360,
    margin: 0,
    maxHeight: 'min(72vh, calc(100vh - 24px))',
    overflowY: 'auto',
  };
}

export interface PlaybackDelayModalProps {
  open: boolean;
  onClose: () => void;
  /** When set, panel is fixed just above this element (transport strip). */
  anchorRef?: React.RefObject<HTMLElement | null>;
}

export default function PlaybackDelayModal({ open, onClose, anchorRef }: PlaybackDelayModalProps) {
  const { t } = useTranslation();
  const {
    isPlaying,
    currentTrack,
    currentRadio,
    scheduledPauseAtMs,
    scheduledResumeAtMs,
    schedulePauseIn,
    scheduleResumeIn,
    clearScheduledPause,
    clearScheduledResume,
  } = usePlayerStore(
    useShallow(s => ({
      isPlaying: s.isPlaying,
      currentTrack: s.currentTrack,
      currentRadio: s.currentRadio,
      scheduledPauseAtMs: s.scheduledPauseAtMs,
      scheduledResumeAtMs: s.scheduledResumeAtMs,
      schedulePauseIn: s.schedulePauseIn,
      scheduleResumeIn: s.scheduleResumeIn,
      clearScheduledPause: s.clearScheduledPause,
      clearScheduledResume: s.clearScheduledResume,
    })),
  );

  const [nowTick, setNowTick] = useState(() => Date.now());
  const [posTick, setPosTick] = useState(0);
  const [customMinutes, setCustomMinutes] = useState('');

  useEffect(() => {
    if (!open) return;
    setCustomMinutes('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (scheduledPauseAtMs == null && scheduledResumeAtMs == null) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [open, scheduledPauseAtMs, scheduledResumeAtMs]);

  useEffect(() => {
    if (!open || !anchorRef) return;
    const bump = () => setPosTick(x => x + 1);
    window.addEventListener('resize', bump);
    window.addEventListener('scroll', bump, true);
    return () => {
      window.removeEventListener('resize', bump);
      window.removeEventListener('scroll', bump, true);
    };
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const canPauseLater = isPlaying && (!!currentTrack || !!currentRadio);
  const canStartLater = !isPlaying && (!!currentTrack || !!currentRadio);

  const customSeconds = useMemo(() => {
    const n = parseFloat(customMinutes.replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n * 60);
  }, [customMinutes]);

  const applyPause = (sec: number) => {
    schedulePauseIn(sec);
    onClose();
  };

  const applyStart = (sec: number) => {
    scheduleResumeIn(sec);
    onClose();
  };

  const useAnchor = !!anchorRef;
  const anchorEl = anchorRef?.current ?? null;
  void posTick;
  const anchoredPanelStyle =
    open && useAnchor && anchorEl ? computeAnchoredPanelStyle(anchorEl) : undefined;

  const heading =
    canPauseLater ? t('player.delayPauseSection') : canStartLater ? t('player.delayStartSection') : t('player.delayModalTitle');

  if (!open) return null;

  const defaultPanelStyle: React.CSSProperties = { maxWidth: 360, width: 'min(360px, calc(100vw - 32px))' };
  const panelStyle = anchoredPanelStyle ? { ...defaultPanelStyle, ...anchoredPanelStyle } : defaultPanelStyle;

  return createPortal(
    <div
      className={`modal-overlay playback-delay-modal-overlay${useAnchor ? ' playback-delay-modal-overlay--anchored' : ''}`}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="playback-delay-modal-title"
      style={
        useAnchor
          ? { alignItems: 'stretch', justifyContent: 'flex-start', padding: 0 }
          : { alignItems: 'center', paddingTop: 0 }
      }
    >
      <div
        className="modal-content playback-delay-modal"
        onClick={e => e.stopPropagation()}
        style={panelStyle}
      >
        <button type="button" className="modal-close" onClick={onClose} aria-label={t('player.closeDelayModal')}>
          <X size={18} />
        </button>
        <h3 id="playback-delay-modal-title" className="playback-delay-modal__title">
          {heading}
        </h3>

        {canPauseLater && (
          <>
            {scheduledPauseAtMs != null && (
              <div className="playback-delay-section__head playback-delay-section__head--tight">
                <span className="playback-delay-section__countdown">
                  {t('player.delayIn')} {formatPlaybackScheduleRemaining(scheduledPauseAtMs, nowTick)}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm playback-delay-inline-cancel"
                  aria-label={t('player.delayCancelPause')}
                  onClick={() => clearScheduledPause()}
                >
                  {t('player.delayCancel')}
                </button>
              </div>
            )}
            <div className="playback-delay-chips playback-delay-chips--compact">
              {PRESET_SECONDS.map(sec => (
                <button key={`p-${sec}`} type="button" className="playback-delay-chip" onClick={() => applyPause(sec)}>
                  {formatPresetLabel(sec, t)}
                </button>
              ))}
            </div>
          </>
        )}

        {canStartLater && (
          <>
            {scheduledResumeAtMs != null && (
              <div className="playback-delay-section__head playback-delay-section__head--tight">
                <span className="playback-delay-section__countdown">
                  {t('player.delayIn')} {formatPlaybackScheduleRemaining(scheduledResumeAtMs, nowTick)}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm playback-delay-inline-cancel"
                  aria-label={t('player.delayCancelStart')}
                  onClick={() => clearScheduledResume()}
                >
                  {t('player.delayCancel')}
                </button>
              </div>
            )}
            <div className="playback-delay-chips playback-delay-chips--compact">
              {PRESET_SECONDS.map(sec => (
                <button key={`s-${sec}`} type="button" className="playback-delay-chip" onClick={() => applyStart(sec)}>
                  {formatPresetLabel(sec, t)}
                </button>
              ))}
            </div>
          </>
        )}

        {!canPauseLater && !canStartLater && (
          <div className="playback-delay-idle">
            <p className="playback-delay-muted">{t('player.delayInactivePause')}</p>
            <p className="playback-delay-muted">{t('player.delayInactiveStart')}</p>
          </div>
        )}

        {(canPauseLater || canStartLater) && (
          <div className="playback-delay-custom playback-delay-custom--inline">
            <input
              id="playback-delay-custom-min"
              type="text"
              inputMode="decimal"
              className="playback-delay-custom__input"
              placeholder={t('player.delayCustomPlaceholder')}
              value={customMinutes}
              onChange={e => setCustomMinutes(e.target.value)}
              aria-label={t('player.delayCustomMinutes')}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={customSeconds == null}
              aria-label={canPauseLater ? t('player.delaySchedulePause') : t('player.delayScheduleStart')}
              onClick={() => {
                if (customSeconds == null) return;
                if (canPauseLater) applyPause(customSeconds);
                else applyStart(customSeconds);
              }}
            >
              {t('player.delayApply')}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
