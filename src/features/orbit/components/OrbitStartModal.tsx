import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  X, Check, Copy, Orbit as OrbitIcon,
  Dices, AlertTriangle, Globe2,
} from 'lucide-react';
import {
  startOrbitSession,
  buildOrbitShareLink,
  generateSessionId,
} from '@/features/orbit/utils/orbit';
import { randomOrbitSessionName } from '@/features/orbit/utils/orbitNames';
import { useAuthStore } from '@/store/authStore';
import { usePlayerStore } from '@/features/playback/store/playerStore';
import { isLanUrl, serverShareBaseUrl } from '@/lib/server/serverEndpoint';
import { ORBIT_DEFAULT_MAX_USERS } from '@/features/orbit/api/orbit';

interface Props { onClose: () => void; }

/**
 * Orbit — start-session modal.
 *
 * One-screen flow: a share-link is shown immediately (built from a
 * pre-generated session id + a slug derived from the live name). The host
 * can copy it any time; pressing "Start" creates the session under that
 * same id and auto-copies the link if it hasn't been copied yet.
 */
export default function OrbitStartModal({ onClose }: Props) {
  const { t } = useTranslation();
  const [sid]                     = useState(() => generateSessionId());
  const [name, setName]           = useState(() => randomOrbitSessionName());
  const [maxUsers, setMaxUsers]   = useState(ORBIT_DEFAULT_MAX_USERS);
  const [busy, setBusy]           = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [copied, setCopied]       = useState(false);
  const [hasCopied, setHasCopied] = useState(false);
  const [clearQueue, setClearQueue] = useState(false);

  const server     = useAuthStore.getState().getActiveServer();
  // Orbit links go to remote guests — use the share URL (public by default
  // when both are set; LAN only if shareUsesLocalUrl is on). The LAN warning
  // then correctly reads the address the guest will actually see.
  const serverBase = server ? serverShareBaseUrl(server) : '';
  const serverName = server?.name ?? server?.url ?? t('orbit.fallbackServer');
  const onLan      = isLanUrl(serverBase);

  const shareLink = useMemo(
    () => buildOrbitShareLink(serverBase, sid),
    // React Compiler rule: manual memoization is intentional and must be preserved.
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    [serverBase, sid],
  );

  const writeLinkToClipboard = async (): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(shareLink);
      return true;
    } catch {
      return false;
    }
  };

  const onCopy = async () => {
    const ok = await writeLinkToClipboard();
    if (ok) {
      setCopied(true);
      setHasCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const onStart = async () => {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) { setError(t('orbit.errNameRequired')); return; }

    if (!hasCopied) {
      const ok = await writeLinkToClipboard();
      if (ok) setHasCopied(true);
    }

    setBusy(true);
    try {
      if (clearQueue) usePlayerStore.getState().clearQueue();
      await startOrbitSession({ name: trimmed, maxUsers, sid });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('orbit.errStartFailed'));
    } finally {
      setBusy(false);
    }
  };

  const heroSubParts = t('orbit.heroSub', { server: serverName }).split(String(serverName));

  return createPortal(
    <div
      className="modal-overlay orbit-start-overlay"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="orbit-start-title"
    >
      <div className="modal-content orbit-start-modal">
        <button type="button" className="modal-close" onClick={onClose} aria-label={t('orbit.closeAria')}>
          <X size={18} />
        </button>

        <div className="orbit-start-modal__hero">
          <div className="orbit-start-modal__hero-icon">
            <OrbitIcon size={24} />
          </div>
          <h3 id="orbit-start-title" className="orbit-start-modal__title">
            {t('orbit.heroTitlePrefix')}{' '}
            <span className="orbit-start-modal__brand">{t('orbit.heroTitleBrand')}</span>
          </h3>
          <p className="orbit-start-modal__sub">
            {heroSubParts[0]}
            <strong>{serverName}</strong>
            {heroSubParts[1] ?? ''}
          </p>
        </div>

        <div
          className={`orbit-start-modal__tip${onLan ? ' orbit-start-modal__tip--warn' : ''}`}
          role={onLan ? 'alert' : undefined}
        >
          {onLan ? <AlertTriangle size={15} /> : <Globe2 size={15} />}
          <span>{onLan ? t('orbit.tipLan') : t('orbit.tipRemote')}</span>
        </div>

        <div className="orbit-start-modal__field">
          <label className="orbit-start-modal__label" htmlFor="orbit-name">
            {t('orbit.labelName')}
          </label>
          <div className="orbit-start-modal__input-row">
            <input
              id="orbit-name"
              type="text"
              autoFocus
              value={name}
              onChange={e => { setName(e.target.value); setHasCopied(false); }}
              onKeyDown={e => {
                if (e.key !== 'Enter') return;
                if (busy || !name.trim()) return;
                e.preventDefault();
                void onStart();
              }}
              placeholder={t('orbit.namePlaceholder')}
              maxLength={40}
              className="orbit-start-modal__input"
            />
            <button
              type="button"
              className="orbit-start-modal__reshuffle"
              onClick={() => { setName(randomOrbitSessionName()); setHasCopied(false); }}
              data-tooltip={t('orbit.reshuffleTooltip')}
              aria-label={t('orbit.reshuffleAria')}
            >
              <Dices size={15} />
            </button>
          </div>
          <div className="orbit-start-modal__helper">{t('orbit.helperName')}</div>
        </div>

        <div className="orbit-start-modal__field">
          <label className="orbit-start-modal__label" htmlFor="orbit-max">
            {t('orbit.labelMax')}: <strong>{maxUsers}</strong>
          </label>
          <input
            id="orbit-max"
            type="range"
            min={1}
            max={32}
            value={maxUsers}
            onChange={e => setMaxUsers(Number(e.target.value))}
            className="orbit-start-modal__range"
          />
          <div className="orbit-start-modal__helper">{t('orbit.helperMax')}</div>
        </div>

        <div className="orbit-start-modal__field">
          <label className="orbit-start-modal__toggle-row">
            <div className="orbit-start-modal__toggle-text">
              <div className="orbit-start-modal__label">{t('orbit.labelClearQueue')}</div>
              <div className="orbit-start-modal__helper">{t('orbit.helperClearQueue')}</div>
            </div>
            <span className="toggle-switch">
              <input
                type="checkbox"
                checked={clearQueue}
                onChange={e => setClearQueue(e.target.checked)}
              />
              <span className="toggle-track" />
            </span>
          </label>
        </div>

        <div className="orbit-start-modal__field">
          <label className="orbit-start-modal__label">{t('orbit.labelLink')}</label>
          <div className="orbit-start-modal__link">
            <code>{shareLink}</code>
            <button
              type="button"
              className="orbit-start-modal__copy"
              onClick={onCopy}
              data-tooltip={copied ? t('orbit.tooltipCopied') : t('orbit.tooltipCopy')}
              aria-label={t('orbit.ariaCopyLink')}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <div className="orbit-start-modal__helper">{t('orbit.helperLink')}</div>
        </div>

        {error && <div className="orbit-start-modal__error">{error}</div>}

        <div className="orbit-start-modal__actions">
          <button type="button" className="btn btn-surface" onClick={onClose}>
            {t('orbit.btnCancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onStart}
            disabled={busy || !name.trim()}
          >
            {busy
              ? t('orbit.btnStarting')
              : hasCopied ? t('orbit.btnStart') : t('orbit.btnCopyAndStart')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
