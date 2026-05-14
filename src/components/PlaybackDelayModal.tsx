import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Moon, Sunrise } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePlayerStore } from '../store/playerStore';
import { useShallow } from 'zustand/react/shallow';

import type { TFunction } from 'i18next';
import { formatPlaybackScheduleRemaining } from '../utils/format/playbackScheduleFormat';
import { formatClockTime } from '../utils/format/formatClockTime';

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
  /** Preset-seconds the user is currently hovering — drives the live "Pauses at HH:MM" preview. */
  const [hoverSeconds, setHoverSeconds] = useState<number | null>(null);
  const customInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setCustomMinutes('');
    setHoverSeconds(null);
  }, [open]);

  // While modal is open, refresh the "now" tick every second so the live
  // preview clock stays accurate.
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
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

  // Mode determines icon + colour accent ("mood") of the modal.
  const mode: 'pause' | 'start' | 'idle' =
    canPauseLater ? 'pause' : canStartLater ? 'start' : 'idle';
  const HeadingIcon = mode === 'pause' ? Moon : mode === 'start' ? Sunrise : null;

  // Live preview: seconds that would be applied right now if the user clicked.
  // Priority: hovered chip → typed custom minutes → nothing.
  const previewSeconds = hoverSeconds ?? customSeconds;
  const previewAtMs = previewSeconds != null ? nowTick + previewSeconds * 1000 : null;
  const previewClock = previewAtMs != null ? formatClockTime(previewAtMs) : null;

  if (!open) return null;

  const defaultPanelStyle: React.CSSProperties = { maxWidth: 360, width: 'min(360px, calc(100vw - 32px))' };
  const panelStyle = anchoredPanelStyle ? { ...defaultPanelStyle, ...anchoredPanelStyle } : defaultPanelStyle;

  const scheduledAt = canPauseLater ? scheduledPauseAtMs : canStartLater ? scheduledResumeAtMs : null;
  const clearScheduled = canPauseLater ? clearScheduledPause : canStartLater ? clearScheduledResume : null;
  const cancelLabel = canPauseLater ? t('player.delayCancelPause') : t('player.delayCancelStart');
  const apply = canPauseLater ? applyPause : applyStart;

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
        className={`modal-content playback-delay-modal playback-delay-modal--${mode}`}
        data-pd-mode={mode}
        onClick={e => e.stopPropagation()}
        style={panelStyle}
      >
        <button type="button" className="modal-close" onClick={onClose} aria-label={t('player.closeDelayModal')}>
          <X size={18} />
        </button>

        <div className="playback-delay-modal__head">
          {HeadingIcon && (
            <span className="playback-delay-modal__icon" aria-hidden="true">
              <HeadingIcon size={18} />
            </span>
          )}
          <h3 id="playback-delay-modal-title" className="playback-delay-modal__title">
            {heading}
          </h3>
        </div>

        {(canPauseLater || canStartLater) && (
          <>
            {scheduledAt != null && (
              <div className="playback-delay-section__head playback-delay-section__head--tight">
                <span className="playback-delay-section__countdown">
                  {t('player.delayIn')} {formatPlaybackScheduleRemaining(scheduledAt, nowTick)}
                </span>
                {clearScheduled && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm playback-delay-inline-cancel"
                    aria-label={cancelLabel}
                    onClick={() => clearScheduled()}
                  >
                    {t('player.delayCancel')}
                  </button>
                )}
              </div>
            )}
            <div
              className="playback-delay-chips playback-delay-chips--compact"
              onMouseLeave={() => setHoverSeconds(null)}
            >
              {PRESET_SECONDS.map(sec => (
                <button
                  key={`pr-${sec}`}
                  type="button"
                  className="playback-delay-chip"
                  onMouseEnter={() => setHoverSeconds(sec)}
                  onFocus={() => setHoverSeconds(sec)}
                  onBlur={() => setHoverSeconds(null)}
                  onClick={() => apply(sec)}
                >
                  {formatPresetLabel(sec, t)}
                </button>
              ))}
            </div>

            <div className="playback-delay-custom playback-delay-custom--inline">
              <div className="playback-delay-custom__field">
                <input
                  ref={customInputRef}
                  id="playback-delay-custom-min"
                  type="text"
                  inputMode="decimal"
                  className="playback-delay-custom__input"
                  placeholder={t('player.delayCustomPlaceholder')}
                  value={customMinutes}
                  onChange={e => setCustomMinutes(e.target.value)}
                  aria-label={t('player.delayCustomMinutes')}
                />
                <span className="playback-delay-custom__suffix" aria-hidden="true">min</span>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                disabled={customSeconds == null}
                aria-label={canPauseLater ? t('player.delaySchedulePause') : t('player.delayScheduleStart')}
                onClick={() => { if (customSeconds != null) apply(customSeconds); }}
              >
                {t('player.delayApply')}
              </button>
            </div>

            <div
              className="playback-delay-preview"
              aria-live="polite"
              data-empty={previewClock == null ? 'true' : 'false'}
            >
              {previewClock != null && (
                <>
                  <span className="playback-delay-preview__label">
                    {canPauseLater ? t('player.delayPreviewPause') : t('player.delayPreviewStart')}
                  </span>
                  <span className="playback-delay-preview__time">{previewClock}</span>
                </>
              )}
            </div>
          </>
        )}

        {!canPauseLater && !canStartLater && (
          <div className="playback-delay-idle">
            <p className="playback-delay-muted">{t('player.delayInactivePause')}</p>
            <p className="playback-delay-muted">{t('player.delayInactiveStart')}</p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
