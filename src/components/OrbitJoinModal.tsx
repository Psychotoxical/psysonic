import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, LogIn, ClipboardPaste } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../store/authStore';
import {
  parseOrbitShareLink,
  findSessionPlaylistId,
  readOrbitState,
  joinOrbitSession,
} from '../utils/orbit';
import { switchActiveServer } from '../utils/server/switchActiveServer';
import { useOrbitAccountPickerStore } from '../store/orbitAccountPickerStore';
import { showToast } from '../utils/ui/toast';

interface Props {
  onClose: () => void;
}

/**
 * Orbit — manual join modal. Alternative to the Ctrl+V paste shortcut for
 * users who don't want to (or can't) paste the invite link into the app
 * directly. Reuses the same parse + preflight pipeline the clipboard
 * handler uses, so error surfaces stay consistent.
 */
export default function OrbitJoinModal({ onClose }: Props) {
  const { t } = useTranslation();
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPaste = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip) setLink(clip);
    } catch { /* silent — clipboard perms vary */ }
  };

  const onJoin = async () => {
    setError(null);
    const text = link.trim();
    if (!text) { setError(t('orbit.joinErrEmpty')); return; }
    const parsed = parseOrbitShareLink(text);
    if (!parsed) { setError(t('orbit.joinErrInvalid')); return; }

    const active = useAuthStore.getState().getActiveServer();
    const activeUrl = (active?.url ?? '').replace(/\/+$/, '');
    const wantUrl   = parsed.serverBase.replace(/\/+$/, '');

    setBusy(true);
    try {
      // Auto-switch to the link's server if the user has an account for it.
      // Multiple candidates → picker modal. switch tears down any lingering
      // orbit session.
      if (activeUrl !== wantUrl) {
        const candidates = useAuthStore.getState().servers
          .filter(s => s.url.replace(/\/+$/, '') === wantUrl);
        if (candidates.length === 0) {
          setError(t('orbit.toastNoAccountForServer', { url: wantUrl }));
          return;
        }
        const target = candidates.length === 1
          ? candidates[0]
          : await useOrbitAccountPickerStore.getState().request(candidates);
        if (!target) { setBusy(false); return; }
        const switched = await switchActiveServer(target);
        if (!switched) {
          setError(t('orbit.toastSwitchFailed', { url: wantUrl }));
          return;
        }
      }

      const playlistId = await findSessionPlaylistId(parsed.sid);
      if (!playlistId) { setError(t('orbit.joinErrNotFound')); return; }
      const state = await readOrbitState(playlistId);
      if (!state)      { setError(t('orbit.joinErrNotFound')); return; }
      if (state.ended) { setError(t('orbit.joinErrEnded')); return; }
      await joinOrbitSession(parsed.sid);
      showToast(t('orbit.toastJoined'), 2200, 'info');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('orbit.toastJoinFail'));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="modal-overlay orbit-start-overlay"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="orbit-join-title"
    >
      <div className="modal-content orbit-start-modal">
        <button type="button" className="modal-close" onClick={onClose} aria-label={t('orbit.closeAria')}>
          <X size={18} />
        </button>

        <div className="orbit-start-modal__hero">
          <div className="orbit-start-modal__hero-icon">
            <LogIn size={24} />
          </div>
          <h3 id="orbit-join-title" className="orbit-start-modal__title">
            {t('orbit.joinModalTitle')}
          </h3>
          <p className="orbit-start-modal__sub">{t('orbit.joinModalSub')}</p>
        </div>

        <div className="orbit-start-modal__field">
          <label className="orbit-start-modal__label" htmlFor="orbit-join-link">
            {t('orbit.joinModalLinkLabel')}
          </label>
          <div className="orbit-start-modal__input-row">
            <input
              id="orbit-join-link"
              type="text"
              autoFocus
              value={link}
              onChange={e => { setLink(e.target.value); setError(null); }}
              onKeyDown={e => { if (e.key === 'Enter' && !busy) void onJoin(); }}
              placeholder={t('orbit.joinModalLinkPlaceholder')}
              className="orbit-start-modal__input"
            />
            <button
              type="button"
              className="orbit-start-modal__reshuffle"
              onClick={onPaste}
              data-tooltip={t('orbit.joinModalPasteTooltip')}
              aria-label={t('orbit.joinModalPasteTooltip')}
            >
              <ClipboardPaste size={15} />
            </button>
          </div>
          <div className="orbit-start-modal__helper">{t('orbit.joinModalLinkHelper')}</div>
        </div>

        {error && <div className="orbit-start-modal__error">{error}</div>}

        <div className="orbit-start-modal__actions">
          <button type="button" className="btn btn-surface" onClick={onClose}>
            {t('orbit.btnCancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onJoin}
            disabled={busy || !link.trim()}
          >
            {busy ? t('orbit.joinModalBusy') : t('orbit.joinModalSubmit')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
