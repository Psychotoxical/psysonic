import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { TFunction } from 'i18next';
import { ndUpdateUser, type NdUser } from '../../../api/navidromeAdmin';
import { showToast } from '../../../utils/toast';
import {
  copyTextToClipboard,
  encodeServerMagicString,
} from '../../../utils/serverMagicString';
import { shortHostFromServerUrl } from '../../../utils/serverDisplayName';

interface Props {
  user: NdUser;
  serverUrl: string;
  token: string;
  onClose: () => void;
  onSuccess: () => Promise<void> | void;
  t: TFunction;
}

/**
 * Generate-magic-string flow for an existing non-admin user. The admin
 * supplies a new password (Navidrome doesn't expose passwords in admin
 * APIs, so we must re-set one); on success we encode it into a server
 * magic string, copy it to the clipboard, and let the parent reload the
 * list.
 *
 * Rendered into `document.body` via portal so the modal escapes the
 * settings overflow box.
 */
export function MagicStringModal({
  user,
  serverUrl,
  token,
  onClose,
  onSuccess,
  t,
}: Props) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const closeIfIdle = () => {
    if (!submitting) onClose();
  };

  const handleConfirm = () => {
    if (!password.trim() || !token) return;
    void (async () => {
      setSubmitting(true);
      try {
        await ndUpdateUser(serverUrl, token, user.id, {
          userName: user.userName,
          name: user.name,
          email: user.email,
          password: password.trim(),
          isAdmin: user.isAdmin,
        });
      } catch (e) {
        const msg = (e instanceof Error && e.message) ? e.message : (typeof e === 'string' ? e : null);
        showToast(msg ?? t('settings.userMgmtUpdateError'), 5000, 'error');
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
      const str = encodeServerMagicString({
        url: serverUrl,
        username: user.userName,
        password: password.trim(),
        name: shortHostFromServerUrl(serverUrl),
      });
      const ok = await copyTextToClipboard(str);
      showToast(
        ok ? t('settings.userMgmtMagicStringCopied') : t('settings.userMgmtMagicStringCopyFailed'),
        ok ? 3000 : 5000,
        ok ? 'info' : 'error',
      );
      if (ok) {
        onClose();
        await onSuccess();
      }
    })();
  };

  return createPortal(
    <div
      className="modal-overlay"
      onClick={closeIfIdle}
      role="dialog"
      aria-modal="true"
      style={{ alignItems: 'center', paddingTop: 0 }}
    >
      <div
        className="modal-content"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: '400px' }}
      >
        <button
          type="button"
          className="modal-close"
          onClick={closeIfIdle}
          aria-label={t('settings.userMgmtCancel')}
        >
          <X size={18} />
        </button>
        <h3 style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-display)' }}>
          {t('settings.userMgmtMagicStringModalTitle')}
        </h3>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '0.75rem', lineHeight: 1.5, fontSize: 13 }}>
          {t('settings.userMgmtMagicStringModalDesc', { username: user.userName })}
        </p>
        <p style={{ color: 'var(--text-muted)', marginBottom: '0.75rem', lineHeight: 1.45, fontSize: 12 }}>
          {t('settings.userMgmtMagicStringPasswordNavHint')}
        </p>
        <div
          role="note"
          style={{
            fontSize: 11,
            lineHeight: 1.45,
            marginBottom: '1rem',
            padding: '8px 10px',
            borderRadius: 6,
            border: '1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 35%, transparent)',
            background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 10%, transparent)',
            color: 'var(--text-primary)',
          }}
        >
          {t('settings.userMgmtMagicStringPlaintextWarning')}
        </div>
        <div className="form-group" style={{ marginBottom: '1.25rem' }}>
          <label style={{ fontSize: 13 }}>{t('settings.userMgmtPassword')}</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="off"
            disabled={submitting}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={closeIfIdle}
            disabled={submitting}
          >
            {t('settings.userMgmtCancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!password.trim() || submitting}
            onClick={handleConfirm}
          >
            {t('settings.userMgmtMagicStringModalConfirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
