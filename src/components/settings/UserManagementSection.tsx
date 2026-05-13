import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { RotateCcw, UserPlus, Users, X } from 'lucide-react';
import {
  ndUpdateUser,
  type NdUser,
} from '../../api/navidromeAdmin';
import ConfirmModal from '../ConfirmModal';
import { showToast } from '../../utils/toast';
import {
  copyTextToClipboard,
  encodeServerMagicString,
} from '../../utils/serverMagicString';
import { shortHostFromServerUrl } from '../../utils/serverDisplayName';
import { useUserMgmtData } from '../../hooks/useUserMgmtData';
import { useUserMgmtActions } from '../../hooks/useUserMgmtActions';
import { UserForm } from './UserForm';
import { UserMgmtRow } from './userMgmt/UserMgmtRow';

export function UserManagementSection({
  serverUrl,
  token,
  currentUsername,
}: {
  serverUrl: string;
  token: string;
  currentUsername: string;
}) {
  const { t, i18n } = useTranslation();
  const { users, libraries, loading, loadError, load } = useUserMgmtData(serverUrl, token, t);
  const [editing, setEditing] = useState<NdUser | 'new' | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<NdUser | null>(null);
  const [magicRowUser, setMagicRowUser] = useState<NdUser | null>(null);
  const [magicRowPassword, setMagicRowPassword] = useState('');
  const [magicRowSubmitting, setMagicRowSubmitting] = useState(false);
  const { busy, handleSave, handleSaveAndGetMagic, performDelete } = useUserMgmtActions({
    serverUrl, token, libraries, editing, setEditing, reload: load, t,
  });

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <Users size={18} />
        <h2>{t('settings.userMgmtTitle')}</h2>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
        {t('settings.userMgmtDesc')}
      </div>

      {loading && (
        <div className="settings-card" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="spinner" style={{ width: 14, height: 14 }} />
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>…</span>
        </div>
      )}

      {!loading && loadError && (
        <div
          className="settings-card"
          style={{
            color: 'var(--danger)',
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('settings.userMgmtLoadFriendly')}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', wordBreak: 'break-word' }}>{loadError}</div>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void load()}
            style={{ flexShrink: 0 }}
          >
            <RotateCcw size={14} /> {t('settings.userMgmtRetry')}
          </button>
        </div>
      )}

      {!loading && !loadError && (
        <>
          {editing ? (
            <UserForm
              initial={editing === 'new' ? null : editing}
              libraries={libraries}
              shareServerUrl={serverUrl}
              ndToken={token}
              onUsersDirty={load}
              onSave={handleSave}
              onSaveAndGetMagic={editing === 'new' ? handleSaveAndGetMagic : undefined}
              onCancel={() => setEditing(null)}
              busy={busy}
            />
          ) : (
            <button
              className="btn btn-surface"
              style={{ marginBottom: '0.75rem' }}
              onClick={() => setEditing('new')}
              disabled={busy}
            >
              <UserPlus size={16} /> {t('settings.userMgmtAddUser')}
            </button>
          )}

          {users.length === 0 ? (
            <div className="settings-card" style={{ color: 'var(--text-muted)', fontSize: 14 }}>
              {t('settings.userMgmtEmpty')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {users.map(u => (
                <UserMgmtRow
                  key={u.id}
                  user={u}
                  libraries={libraries}
                  isSelf={u.userName === currentUsername}
                  busy={busy}
                  onEdit={setEditing}
                  onRequestDelete={setConfirmingDelete}
                  onRequestMagic={(target) => {
                    setMagicRowUser(target);
                    setMagicRowPassword('');
                  }}
                  t={t}
                  i18n={i18n}
                />
              ))}
            </div>
          )}
        </>
      )}
      <ConfirmModal
        open={!!confirmingDelete}
        title={t('settings.userMgmtDelete')}
        message={confirmingDelete
          ? t('settings.userMgmtConfirmDelete', { username: confirmingDelete.userName })
          : ''}
        confirmLabel={t('settings.userMgmtDelete')}
        cancelLabel={t('settings.userMgmtCancel')}
        danger
        onConfirm={() => {
          if (!confirmingDelete) return;
          const target = confirmingDelete;
          setConfirmingDelete(null);
          void performDelete(target);
        }}
        onCancel={() => setConfirmingDelete(null)}
      />
      {magicRowUser && createPortal(
        <div
          className="modal-overlay"
          onClick={() => !magicRowSubmitting && setMagicRowUser(null)}
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
              onClick={() => !magicRowSubmitting && setMagicRowUser(null)}
              aria-label={t('settings.userMgmtCancel')}
            >
              <X size={18} />
            </button>
            <h3 style={{ marginBottom: '0.5rem', fontFamily: 'var(--font-display)' }}>
              {t('settings.userMgmtMagicStringModalTitle')}
            </h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '0.75rem', lineHeight: 1.5, fontSize: 13 }}>
              {t('settings.userMgmtMagicStringModalDesc', { username: magicRowUser.userName })}
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
                value={magicRowPassword}
                onChange={e => setMagicRowPassword(e.target.value)}
                autoComplete="off"
                disabled={magicRowSubmitting}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => !magicRowSubmitting && setMagicRowUser(null)}
                disabled={magicRowSubmitting}
              >
                {t('settings.userMgmtCancel')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!magicRowPassword.trim() || magicRowSubmitting}
                onClick={() => {
                  if (!magicRowUser || !magicRowPassword.trim() || !token) return;
                  void (async () => {
                    setMagicRowSubmitting(true);
                    try {
                      await ndUpdateUser(serverUrl, token, magicRowUser.id, {
                        userName: magicRowUser.userName,
                        name: magicRowUser.name,
                        email: magicRowUser.email,
                        password: magicRowPassword.trim(),
                        isAdmin: magicRowUser.isAdmin,
                      });
                    } catch (e) {
                      const msg = (e instanceof Error && e.message) ? e.message : (typeof e === 'string' ? e : null);
                      showToast(msg ?? t('settings.userMgmtUpdateError'), 5000, 'error');
                      return;
                    } finally {
                      setMagicRowSubmitting(false);
                    }
                    const str = encodeServerMagicString({
                      url: serverUrl,
                      username: magicRowUser.userName,
                      password: magicRowPassword.trim(),
                      name: shortHostFromServerUrl(serverUrl),
                    });
                    const ok = await copyTextToClipboard(str);
                    showToast(
                      ok ? t('settings.userMgmtMagicStringCopied') : t('settings.userMgmtMagicStringCopyFailed'),
                      ok ? 3000 : 5000,
                      ok ? 'info' : 'error',
                    );
                    if (ok) {
                      setMagicRowUser(null);
                      setMagicRowPassword('');
                      await load();
                    }
                  })();
                }}
              >
                {t('settings.userMgmtMagicStringModalConfirm')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}
