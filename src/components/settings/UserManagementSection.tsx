import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { RotateCcw, Shield, Trash2, User, UserPlus, Users, Wand2, X } from 'lucide-react';
import {
  ndCreateUser,
  ndDeleteUser,
  ndListLibraries,
  ndListUsers,
  ndSetUserLibraries,
  ndUpdateUser,
  type NdLibrary,
  type NdUser,
} from '../../api/navidromeAdmin';
import ConfirmModal from '../ConfirmModal';
import { showToast } from '../../utils/toast';
import {
  copyTextToClipboard,
  encodeServerMagicString,
} from '../../utils/serverMagicString';
import { shortHostFromServerUrl } from '../../utils/serverDisplayName';
import { UserForm, type UserFormState } from './UserForm';

function formatLastSeen(iso: string | null | undefined, locale: string, neverLabel: string): string {
  if (!iso) return neverLabel;
  const t = new Date(iso).getTime();
  // Navidrome returns "0001-01-01T00:00:00Z" for never-accessed users → guard against bogus epochs.
  if (!Number.isFinite(t) || t < 1_000_000_000_000) return neverLabel;
  const diffSec = (t - Date.now()) / 1000;
  const abs = Math.abs(diffSec);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 60) return rtf.format(Math.round(diffSec), 'second');
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 604800) return rtf.format(Math.round(diffSec / 86400), 'day');
  if (abs < 2592000) return rtf.format(Math.round(diffSec / 604800), 'week');
  if (abs < 31536000) return rtf.format(Math.round(diffSec / 2592000), 'month');
  return rtf.format(Math.round(diffSec / 31536000), 'year');
}

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
  const [users, setUsers] = useState<NdUser[]>([]);
  const [libraries, setLibraries] = useState<NdLibrary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<NdUser | 'new' | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<NdUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [magicRowUser, setMagicRowUser] = useState<NdUser | null>(null);
  const [magicRowPassword, setMagicRowPassword] = useState('');
  const [magicRowSubmitting, setMagicRowSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // Sequential, not parallel: nginx setups with churning upstream
      // keep-alive drop one of the two parallel TLS connections. Doing
      // users first then libraries keeps us on one connection at a time
      // and pairs cleanly with the nd_retry backoff on the Rust side.
      const list = await ndListUsers(serverUrl, token);
      const libs = await ndListLibraries(serverUrl, token).catch(() => [] as NdLibrary[]);
      setUsers([...list].sort((a, b) => a.userName.localeCompare(b.userName)));
      setLibraries([...libs].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e) {
      // Tauri invoke rejects with a plain string (our Rust returns Err(String)),
      // not an Error instance. Normalise so the surfaced message is the real
      // cause (e.g. "tls handshake eof") rather than the generic i18n fallback.
      const raw = typeof e === 'string'
        ? e
        : (e instanceof Error && e.message)
          ? e.message
          : '';
      const prefix = t('settings.userMgmtLoadError');
      setLoadError(raw ? `${prefix} ${raw}` : prefix);
    } finally {
      setLoading(false);
    }
  }, [serverUrl, token, t]);

  useEffect(() => { void load(); }, [load]);

  const handleSave = async (form: UserFormState) => {
    const userName = form.userName.trim();
    const name = form.name.trim();
    const email = form.email.trim();
    if (editing === 'new') {
      if (!userName || !name || !form.password.trim()) {
        showToast(t('settings.userMgmtValidationMissing'), 4000, 'error');
        return;
      }
    } else if (editing) {
      if (!userName || !name) {
        showToast(t('settings.userMgmtValidationMissingIdentity'), 4000, 'error');
        return;
      }
    }
    if (!form.isAdmin && form.libraryIds.length === 0 && libraries.length > 0) {
      showToast(t('settings.userMgmtLibrariesValidation'), 4000, 'error');
      return;
    }
    if (!token) return;
    setBusy(true);
    try {
      let targetId: string;
      if (editing === 'new') {
        const created = await ndCreateUser(serverUrl, token, {
          userName, name, email, password: form.password, isAdmin: form.isAdmin,
        });
        targetId = created.id;
        showToast(t('settings.userMgmtCreated'), 3000, 'info');
      } else if (editing) {
        await ndUpdateUser(serverUrl, token, editing.id, {
          userName, name, email, password: form.password, isAdmin: form.isAdmin,
        });
        targetId = editing.id;
        showToast(t('settings.userMgmtUpdated'), 3000, 'info');
      } else {
        return;
      }
      if (!form.isAdmin && form.libraryIds.length > 0) {
        try {
          await ndSetUserLibraries(serverUrl, token, targetId, form.libraryIds);
        } catch (e) {
          const msg = (e instanceof Error && e.message) ? e.message : String(e);
          showToast(`${t('settings.userMgmtLibrariesUpdateError')}: ${msg}`, 5000, 'error');
        }
      }
      setEditing(null);
      await load();
    } catch (e) {
      const msg = (e instanceof Error && e.message) ? e.message : (typeof e === 'string' ? e : null);
      const fallback = editing === 'new'
        ? t('settings.userMgmtCreateError')
        : t('settings.userMgmtUpdateError');
      showToast(msg ?? fallback, 5000, 'error');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveAndGetMagic = async (form: UserFormState) => {
    if (editing !== 'new' || form.isAdmin) return;
    const userName = form.userName.trim();
    const name = form.name.trim();
    const email = form.email.trim();
    if (!userName || !name || !form.password.trim()) {
      showToast(t('settings.userMgmtValidationMissing'), 4000, 'error');
      return;
    }
    if (!form.isAdmin && form.libraryIds.length === 0 && libraries.length > 0) {
      showToast(t('settings.userMgmtLibrariesValidation'), 4000, 'error');
      return;
    }
    if (!token) return;
    setBusy(true);
    try {
      const created = await ndCreateUser(serverUrl, token, {
        userName, name, email, password: form.password, isAdmin: form.isAdmin,
      });
      const targetId = created.id;
      showToast(t('settings.userMgmtCreated'), 3000, 'info');
      if (!form.isAdmin && form.libraryIds.length > 0) {
        try {
          await ndSetUserLibraries(serverUrl, token, targetId, form.libraryIds);
        } catch (e) {
          const msg = (e instanceof Error && e.message) ? e.message : String(e);
          showToast(`${t('settings.userMgmtLibrariesUpdateError')}: ${msg}`, 5000, 'error');
        }
      }
      const str = encodeServerMagicString({
        url: serverUrl.trim(),
        username: userName,
        password: form.password,
        name: shortHostFromServerUrl(serverUrl),
      });
      const ok = await copyTextToClipboard(str);
      showToast(
        ok ? t('settings.userMgmtMagicStringCopied') : t('settings.userMgmtMagicStringCopyFailed'),
        ok ? 3000 : 5000,
        ok ? 'info' : 'error',
      );
      setEditing(null);
      await load();
    } catch (e) {
      const msg = (e instanceof Error && e.message) ? e.message : (typeof e === 'string' ? e : null);
      showToast(msg ?? t('settings.userMgmtCreateError'), 5000, 'error');
    } finally {
      setBusy(false);
    }
  };

  const performDelete = async (u: NdUser) => {
    if (!token) return;
    setConfirmingDelete(null);
    setBusy(true);
    try {
      await ndDeleteUser(serverUrl, token, u.id);
      showToast(t('settings.userMgmtDeleted'), 3000, 'info');
      await load();
    } catch (e) {
      const msg = (e instanceof Error && e.message) ? e.message : (typeof e === 'string' ? e : t('settings.userMgmtDeleteError'));
      showToast(msg, 5000, 'error');
    } finally {
      setBusy(false);
    }
  };

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
              {users.map(u => {
                const isSelf = u.userName === currentUsername;
                const libNames = u.isAdmin
                  ? null
                  : u.libraryIds.length === 0
                    ? t('settings.userMgmtNoLibraries')
                    : libraries.filter(l => u.libraryIds.includes(l.id)).map(l => l.name).join(', ');
                const lastSeen = formatLastSeen(u.lastAccessAt, i18n.language, t('settings.userMgmtNeverSeen'));
                const lastSeenAbsolute = u.lastAccessAt
                  ? new Date(u.lastAccessAt).toLocaleString(i18n.language)
                  : '';
                return (
                  <div
                    key={u.id}
                    className="settings-card user-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => { if (!busy) setEditing(u); }}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && !busy) {
                        e.preventDefault();
                        setEditing(u);
                      }
                    }}
                    style={{
                      padding: '6px 10px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      cursor: busy ? 'default' : 'pointer',
                    }}
                  >
                    <User size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                    <span style={{ fontWeight: 600, fontSize: 13, flexShrink: 0 }}>{u.userName}</span>
                    {u.name && u.name !== u.userName && (
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>· {u.name}</span>
                    )}
                    {isSelf && (
                      <span style={{ fontSize: 10, background: 'var(--accent)', color: 'var(--ctp-crust)', padding: '1px 6px', borderRadius: 10, fontWeight: 600, flexShrink: 0 }}>
                        {t('settings.userMgmtYouBadge')}
                      </span>
                    )}
                    {u.isAdmin && (
                      <span
                        style={{ fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px', borderRadius: 10, fontWeight: 600, background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 22%, transparent)', color: 'var(--text-primary)', flexShrink: 0 }}
                        data-tooltip={t('settings.userMgmtRoleAdmin')}
                      >
                        <Shield size={10} />
                        {t('settings.userMgmtAdminBadge')}
                      </span>
                    )}
                    <span style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
                      {libNames || ''}
                    </span>
                    {!u.isAdmin && (
                      <button
                        type="button"
                        className="btn btn-ghost"
                        style={{ padding: '2px 6px', flexShrink: 0 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setMagicRowUser(u);
                          setMagicRowPassword('');
                        }}
                        disabled={busy}
                        data-tooltip={t('settings.userMgmtMagicStringGenerate')}
                      >
                        <Wand2 size={14} />
                      </button>
                    )}
                    <span
                      style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}
                      data-tooltip={lastSeenAbsolute || undefined}
                    >
                      {lastSeen}
                    </span>
                    <button
                      className="btn btn-ghost"
                      style={{ color: 'var(--danger)', padding: '2px 6px', flexShrink: 0 }}
                      onClick={(e) => { e.stopPropagation(); setConfirmingDelete(u); }}
                      disabled={busy || isSelf}
                      data-tooltip={t('settings.userMgmtDelete')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
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
        onConfirm={() => { if (confirmingDelete) void performDelete(confirmingDelete); }}
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
