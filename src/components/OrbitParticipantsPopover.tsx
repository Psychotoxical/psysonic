import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Crown, User, UserMinus, ShieldOff, Mic, MicOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOrbitStore } from '../store/orbitStore';
import { kickOrbitParticipant, removeOrbitParticipant, setOrbitSuggestionBlocked } from '../utils/orbit';
import ConfirmModal from './ConfirmModal';

interface Props {
  /** Anchor — we position the popover directly below its bottom-right. */
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

function joinedFor(fromMs: number, nowMs: number): string {
  const sec = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm.toString().padStart(2, '0')}`;
}

export default function OrbitParticipantsPopover({ anchorRef, onClose }: Props) {
  const { t } = useTranslation();
  const state = useOrbitStore(s => s.state);
  const role  = useOrbitStore(s => s.role);
  const popRef = useRef<HTMLDivElement>(null);
  const [confirm, setConfirm] = useState<{ user: string; mode: 'remove' | 'ban' } | null>(null);
  // React Compiler purity rule: intentional live-timestamp read at render (Date.now()); the value is allowed to differ between renders.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();

  // Close on outside click / Escape — unless a confirm dialog is open
  // (otherwise outside-clicking the modal would dismiss the popover too,
  // and re-opening would lose the in-flight confirm context).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (confirm) return;
      const t = e.target as Node | null;
      if (popRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (confirm) return;
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose, confirm]);

  if (!state) return null;

  // React Compiler refs rule: ref read imperatively outside reactive rendering; not used to compute the render output.
  // eslint-disable-next-line react-hooks/refs
  const anchor = anchorRef.current?.getBoundingClientRect();
  const style: React.CSSProperties = anchor
    ? {
        position: 'fixed',
        top:  anchor.bottom + 12,
        left: Math.max(8, anchor.left - 100),
        zIndex: 9999,
      }
    : { display: 'none' };

  const onConfirm = async () => {
    if (!confirm) return;
    const { user, mode } = confirm;
    setConfirm(null);
    if (mode === 'remove') await removeOrbitParticipant(user);
    else                   await kickOrbitParticipant(user);
  };

  return createPortal(
    <>
    <div ref={popRef} className="orbit-participants-pop" style={style} role="menu">
      <div className="orbit-participants-pop__head">
        {t('orbit.participantsCountLabel', { count: state.participants.length + 1 })}
      </div>

      <div className="orbit-participants-pop__row orbit-participants-pop__row--host">
        <Crown size={13} />
        <span className="orbit-participants-pop__name">{state.host}</span>
        <span className="orbit-participants-pop__meta">{t('orbit.participantsHost')}</span>
      </div>

      {state.participants.length === 0 && (
        <div className="orbit-participants-pop__empty">{t('orbit.participantsEmpty')}</div>
      )}

      {state.participants.map(p => {
        const isMuted = state.suggestionBlocked?.includes(p.user) ?? false;
        return (
          <div key={p.user} className="orbit-participants-pop__row">
            <User size={13} />
            <span className="orbit-participants-pop__name">{p.user}</span>
            <span className="orbit-participants-pop__meta">{joinedFor(p.joinedAt, nowMs)}</span>
            {role === 'host' && (
              <div className="orbit-participants-pop__actions">
                <button
                  type="button"
                  className={`orbit-participants-pop__kick${isMuted ? ' is-active' : ''}`}
                  onClick={() => { void setOrbitSuggestionBlocked(p.user, !isMuted); }}
                  data-tooltip={isMuted ? t('orbit.participantsUnmuteTooltip') : t('orbit.participantsMuteTooltip')}
                  aria-label={isMuted
                    ? t('orbit.participantsUnmuteAria', { user: p.user })
                    : t('orbit.participantsMuteAria',   { user: p.user })}
                  aria-pressed={isMuted}
                >
                  {isMuted ? <MicOff size={12} /> : <Mic size={12} />}
                </button>
                <button
                  type="button"
                  className="orbit-participants-pop__kick"
                  onClick={() => setConfirm({ user: p.user, mode: 'remove' })}
                  data-tooltip={t('orbit.participantsRemoveTooltip')}
                  aria-label={t('orbit.participantsRemoveAria', { user: p.user })}
                >
                  <UserMinus size={12} />
                </button>
                <button
                  type="button"
                  className="orbit-participants-pop__kick orbit-participants-pop__kick--ban"
                  onClick={() => setConfirm({ user: p.user, mode: 'ban' })}
                  data-tooltip={t('orbit.participantsBanTooltip')}
                  aria-label={t('orbit.participantsBanAria', { user: p.user })}
                >
                  <ShieldOff size={12} />
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
    <ConfirmModal
      open={!!confirm}
      title={confirm?.mode === 'ban'
        ? t('orbit.confirmBanTitle')
        : t('orbit.confirmRemoveTitle')}
      message={confirm?.mode === 'ban'
        ? t('orbit.confirmBanBody',    { user: confirm?.user ?? '' })
        : t('orbit.confirmRemoveBody', { user: confirm?.user ?? '' })}
      confirmLabel={confirm?.mode === 'ban'
        ? t('orbit.confirmBanConfirm')
        : t('orbit.confirmRemoveConfirm')}
      cancelLabel={t('orbit.confirmCancel')}
      danger={confirm?.mode === 'ban'}
      onConfirm={() => { void onConfirm(); }}
      onCancel={() => setConfirm(null)}
    />
    </>,
    document.body,
  );
}
