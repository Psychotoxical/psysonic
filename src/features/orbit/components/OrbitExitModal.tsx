import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useOrbitStore } from '@/features/orbit/store/orbitStore';
import { leaveOrbitSession } from '@/features/orbit/utils/orbit';

/**
 * Orbit — exit notification modal.
 *
 * Shown when:
 *   - `phase === 'ended'` (host closed the session; guest sees it)
 *   - `phase === 'error' && errorMessage === 'kicked'`  (host permanently banned us)
 *   - `phase === 'error' && errorMessage === 'removed'` (host soft-removed us;
 *     re-join via invite link still works)
 *
 * "OK" cleans up the guest-side outbox + resets the local store.
 */
export default function OrbitExitModal() {
  const { t } = useTranslation();
  const phase        = useOrbitStore(s => s.phase);
  const errorMessage = useOrbitStore(s => s.errorMessage);
  const sessionName  = useOrbitStore(s => s.state?.name);
  const hostName     = useOrbitStore(s => s.state?.host);

  const isEnded       = phase === 'ended';
  const isKicked      = phase === 'error' && errorMessage === 'kicked';
  const isRemoved     = phase === 'error' && errorMessage === 'removed';
  const isHostTimeout = phase === 'error' && errorMessage === 'host-timeout';
  const isOpen = isEnded || isKicked || isRemoved || isHostTimeout;

  const onOk = async () => {
    try {
      // Read role fresh from the store — the keydown effect binds once per
      // open (deps [isOpen]) and would otherwise act on a stale role if it
      // changed while the modal was up.
      if (useOrbitStore.getState().role === 'guest') await leaveOrbitSession();
      else useOrbitStore.getState().reset();
    } catch {
      useOrbitStore.getState().reset();
    }
  };

  // Modal is informational with a single action — Enter / Escape both fire OK.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); void onOk(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen]);

  if (!isOpen) return null;

  const title = isKicked
    ? t('orbit.exitKickedTitle')
    : isRemoved
      ? t('orbit.exitRemovedTitle')
      : isHostTimeout
        ? t('orbit.exitHostTimeoutTitle')
        : t('orbit.exitEndedTitle');
  const body = isKicked
    ? t('orbit.exitKickedBody',  { host: hostName ?? '', name: sessionName ?? '' })
    : isRemoved
      ? t('orbit.exitRemovedBody', { host: hostName ?? '', name: sessionName ?? '' })
      : isHostTimeout
        ? t('orbit.exitHostTimeoutBody', { host: hostName ?? '', name: sessionName ?? '' })
        : t('orbit.exitEndedBody',   { name: sessionName ?? '' });

  return createPortal(
    <div
      className="modal-overlay orbit-exit-overlay"
      onClick={e => { if (e.target === e.currentTarget) onOk(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="orbit-exit-title"
    >
      <div className="modal-content orbit-exit-modal">
        <h3 id="orbit-exit-title" className="orbit-exit-modal__title">{title}</h3>
        <p className="orbit-exit-modal__body">{body}</p>
        <div className="orbit-exit-modal__actions">
          <button type="button" className="btn btn-primary" onClick={onOk} autoFocus>{t('orbit.exitOk')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
