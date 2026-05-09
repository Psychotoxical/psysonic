import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOrbitStore } from '../store/orbitStore';
import { usePlayerStore } from '../store/playerStore';
import { showToast } from '../utils/toast';
import { computeOrbitDriftMs } from '../utils/orbit';
import {
  clearOrbitEvents,
  formatOrbitEvents,
  getOrbitEvents,
  subscribeOrbitEvents,
} from '../utils/orbitDiag';

interface Props {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

/**
 * Live diagnostic popover for the Orbit bar. Renders a mini-summary of the
 * host vs guest state plus a scrolling event log captured by `orbitDiag`.
 *
 * The point is "Discord user can paste a buffer" — so the Copy button is
 * the primary action and the textarea is read-only. Clear lets a user wipe
 * the buffer before reproducing a specific symptom.
 */
export default function OrbitDiagnosticsPopover({ anchorRef, onClose }: Props) {
  const { t } = useTranslation();
  const popRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Live event buffer subscription via useSyncExternalStore — no extra
  // re-render cascade, no flicker.
  const events = useSyncExternalStore(subscribeOrbitEvents, getOrbitEvents, getOrbitEvents);
  const formatted = formatOrbitEvents(events);

  // Tick the mini-display once a second so drift / position read fresh.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Auto-scroll the textarea to the bottom whenever a new event lands so
  // the most recent line is always visible without manual scrolling.
  useEffect(() => {
    if (taRef.current) taRef.current.scrollTop = taRef.current.scrollHeight;
  }, [formatted]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (popRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);

  const anchor = anchorRef.current?.getBoundingClientRect();
  const style: React.CSSProperties = anchor
    ? {
        position: 'fixed',
        top:   anchor.bottom + 12,
        right: Math.max(8, window.innerWidth - anchor.right),
        zIndex: 9999,
      }
    : { display: 'none' };

  // ── Live mini-display data ────────────────────────────────────────────
  const role = useOrbitStore(s => s.role);
  const state = useOrbitStore(s => s.state);
  const player = usePlayerStore.getState();
  const localPosMs = Math.round((player.currentTime ?? 0) * 1000);
  const sameTrack = role === 'guest'
    && state?.currentTrack
    && player.currentTrack?.id === state.currentTrack.trackId;
  const driftMs = sameTrack && state ? computeOrbitDriftMs(state, localPosMs, nowMs) : null;
  const hostStateAgeMs = state ? Math.max(0, nowMs - state.positionAt) : null;

  const hostPosSec = state ? Math.round(((state.positionMs ?? 0) + (state.isPlaying ? (nowMs - state.positionAt) : 0)) / 1000) : null;
  const guestPosSec = Math.round((player.currentTime ?? 0));

  const handleCopy = async () => {
    const text = formatted || '(empty)';
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('orbit.diag.copied', { count: events.length }), 2500, 'info');
    } catch {
      showToast(t('orbit.diag.copyFailed'), 4000, 'error');
    }
  };

  const handleClear = () => {
    clearOrbitEvents();
    showToast(t('orbit.diag.cleared'), 2000, 'info');
  };

  return createPortal(
    <div ref={popRef} className="orbit-diag-pop" style={style} role="dialog" aria-label={t('orbit.diag.title')}>
      <div className="orbit-diag-pop__head">{t('orbit.diag.title')}</div>

      <div className="orbit-diag-pop__live">
        <div className="orbit-diag-pop__live-row">
          <span className="orbit-diag-pop__live-label">{t('orbit.diag.role')}</span>
          <span>{role ?? '—'}</span>
        </div>
        <div className="orbit-diag-pop__live-row">
          <span className="orbit-diag-pop__live-label">{t('orbit.diag.hostTrack')}</span>
          <span className="orbit-diag-pop__mono">{state?.currentTrack?.trackId ?? '—'}</span>
        </div>
        <div className="orbit-diag-pop__live-row">
          <span className="orbit-diag-pop__live-label">{t('orbit.diag.hostPos')}</span>
          <span>{hostPosSec != null ? `${hostPosSec}s · ${state?.isPlaying ? '▶' : '⏸'}` : '—'}</span>
        </div>
        {role === 'guest' && (
          <>
            <div className="orbit-diag-pop__live-row">
              <span className="orbit-diag-pop__live-label">{t('orbit.diag.guestTrack')}</span>
              <span className="orbit-diag-pop__mono">{player.currentTrack?.id ?? '—'}</span>
            </div>
            <div className="orbit-diag-pop__live-row">
              <span className="orbit-diag-pop__live-label">{t('orbit.diag.guestPos')}</span>
              <span>{guestPosSec}s · {player.isPlaying ? '▶' : '⏸'}</span>
            </div>
            <div className="orbit-diag-pop__live-row">
              <span className="orbit-diag-pop__live-label">{t('orbit.diag.drift')}</span>
              <span>{driftMs != null ? `${(driftMs / 1000).toFixed(1)}s` : '—'}</span>
            </div>
          </>
        )}
        {hostStateAgeMs != null && (
          <div className="orbit-diag-pop__live-row">
            <span className="orbit-diag-pop__live-label">{t('orbit.diag.stateAge')}</span>
            <span>{(hostStateAgeMs / 1000).toFixed(1)}s</span>
          </div>
        )}
      </div>

      <div className="orbit-diag-pop__log-head">
        <span>{t('orbit.diag.eventLog', { count: events.length })}</span>
        <div className="orbit-diag-pop__btn-row">
          <button
            type="button"
            className="orbit-diag-pop__btn"
            onClick={handleCopy}
            data-tooltip={t('orbit.diag.copyTooltip')}
            aria-label={t('orbit.diag.copyTooltip')}
          >
            <Copy size={13} />
            <span>{t('orbit.diag.copyLabel')}</span>
          </button>
          <button
            type="button"
            className="orbit-diag-pop__btn"
            onClick={handleClear}
            data-tooltip={t('orbit.diag.clearTooltip')}
            aria-label={t('orbit.diag.clearTooltip')}
          >
            <Trash2 size={13} />
            <span>{t('orbit.diag.clearLabel')}</span>
          </button>
        </div>
      </div>
      <textarea
        ref={taRef}
        className="orbit-diag-pop__log"
        readOnly
        value={formatted}
        spellCheck={false}
        placeholder={t('orbit.diag.empty')}
      />
      <div className="orbit-diag-pop__hint">{t('orbit.diag.hint')}</div>
    </div>,
    document.body,
  );
}
