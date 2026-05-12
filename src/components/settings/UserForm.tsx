import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Shield, Wand2 } from 'lucide-react';
import { ndUpdateUser, type NdLibrary, type NdUser } from '../../api/navidromeAdmin';
import { showToast } from '../../utils/toast';
import {
  copyTextToClipboard,
  encodeServerMagicString,
} from '../../utils/serverMagicString';
import { shortHostFromServerUrl } from '../../utils/serverDisplayName';

export interface UserFormState {
  userName: string;
  name: string;
  email: string;
  password: string;
  isAdmin: boolean;
  libraryIds: number[];
}

export function initialUserFormState(u: NdUser | undefined, allLibraries: NdLibrary[]): UserFormState {
  const defaultIds = allLibraries.map(l => l.id);
  return {
    userName: u?.userName ?? '',
    name: u?.name ?? '',
    email: u?.email ?? '',
    password: '',
    isAdmin: !!u?.isAdmin,
    libraryIds: u ? [...u.libraryIds] : defaultIds,
  };
}

export function UserForm({
  initial,
  libraries,
  shareServerUrl,
  ndToken,
  onUsersDirty,
  onSave,
  onSaveAndGetMagic,
  onCancel,
  busy,
}: {
  initial: NdUser | null;
  libraries: NdLibrary[];
  shareServerUrl: string;
  ndToken: string;
  onUsersDirty?: () => void | Promise<void>;
  onSave: (form: UserFormState) => void;
  /** New user only: create on Navidrome then copy magic string to clipboard. */
  onSaveAndGetMagic?: (form: UserFormState) => void | Promise<void>;
  onCancel: () => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<UserFormState>(() => initialUserFormState(initial ?? undefined, libraries));
  const [showPass, setShowPass] = useState(false);
  const [magicGenBusy, setMagicGenBusy] = useState(false);
  const [showNewUserRequiredErrors, setShowNewUserRequiredErrors] = useState(false);
  const isEdit = !!initial;

  useEffect(() => {
    setShowNewUserRequiredErrors(false);
  }, [initial?.id]);

  useEffect(() => {
    if (!isEdit && form.userName.trim() && form.name.trim() && form.password.trim()) {
      setShowNewUserRequiredErrors(false);
    }
  }, [isEdit, form.userName, form.name, form.password]);

  const set = <K extends keyof UserFormState>(k: K, v: UserFormState[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  const toggleLib = (id: number) =>
    setForm(f => ({
      ...f,
      libraryIds: f.libraryIds.includes(id)
        ? f.libraryIds.filter(x => x !== id)
        : [...f.libraryIds, id],
    }));

  const newUserPasswordOk = form.password.trim().length > 0;
  const canSave =
    form.userName.trim().length > 0 &&
    form.name.trim().length > 0 &&
    (isEdit || newUserPasswordOk) &&
    (form.isAdmin || form.libraryIds.length > 0);

  const generateMagicString = async () => {
    if (!shareServerUrl.trim() || !form.password.trim() || !initial || !ndToken.trim()) return;
    setMagicGenBusy(true);
    try {
      await ndUpdateUser(shareServerUrl.trim(), ndToken, initial.id, {
        userName: form.userName.trim(),
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        isAdmin: form.isAdmin,
      });
    } catch (e) {
      const msg = (e instanceof Error && e.message) ? e.message : (typeof e === 'string' ? e : null);
      showToast(msg ?? t('settings.userMgmtUpdateError'), 5000, 'error');
      return;
    } finally {
      setMagicGenBusy(false);
    }
    const str = encodeServerMagicString({
      url: shareServerUrl.trim(),
      username: form.userName.trim(),
      password: form.password,
      name: shortHostFromServerUrl(shareServerUrl),
    });
    const ok = await copyTextToClipboard(str);
    showToast(
      ok ? t('settings.userMgmtMagicStringCopied') : t('settings.userMgmtMagicStringCopyFailed'),
      ok ? 3000 : 5000,
      ok ? 'info' : 'error',
    );
    if (ok) void onUsersDirty?.();
  };

  const runSaveAndGetMagic = async () => {
    if (!onSaveAndGetMagic) return;
    if (!form.userName.trim() || !form.name.trim() || !form.password.trim()) {
      setShowNewUserRequiredErrors(true);
      showToast(t('settings.userMgmtValidationMissing'), 4000, 'error');
      return;
    }
    if (!form.isAdmin && form.libraryIds.length === 0 && libraries.length > 0) {
      showToast(t('settings.userMgmtLibrariesValidation'), 4000, 'error');
      return;
    }
    setMagicGenBusy(true);
    try {
      await onSaveAndGetMagic(form);
    } finally {
      setMagicGenBusy(false);
    }
  };

  const invalidNewUserCore =
    !isEdit && (!form.userName.trim() || !form.name.trim() || !form.password.trim());

  const trySave = () => {
    if (invalidNewUserCore) {
      setShowNewUserRequiredErrors(true);
      showToast(t('settings.userMgmtValidationMissing'), 4000, 'error');
      return;
    }
    onSave(form);
  };

  const markInvalid = showNewUserRequiredErrors && !isEdit;

  return (
    <div className="settings-card" style={{ marginBottom: '1.25rem' }}>
      <h3 style={{ fontWeight: 600, marginBottom: '1rem', fontSize: '14px' }}>
        {isEdit ? t('settings.userMgmtEditUserTitle') : t('settings.userMgmtAddUserTitle')}
      </h3>
      <div className="form-row" style={{ marginBottom: '0.75rem' }}>
        <div className="form-group">
          <label style={{ fontSize: 13 }}>
            {t('settings.userMgmtUsername')}
            {!isEdit && <span style={{ color: 'var(--text-muted)' }}> *</span>}
          </label>
          <input
            className="input"
            type="text"
            value={form.userName}
            onChange={e => set('userName', e.target.value)}
            disabled={isEdit}
            autoComplete="off"
            aria-invalid={markInvalid && !form.userName.trim()}
            style={markInvalid && !form.userName.trim() ? { borderColor: 'var(--danger)' } : undefined}
          />
        </div>
        <div className="form-group">
          <label style={{ fontSize: 13 }}>
            {t('settings.userMgmtName')}
            {!isEdit && <span style={{ color: 'var(--text-muted)' }}> *</span>}
          </label>
          <input
            className="input"
            type="text"
            value={form.name}
            onChange={e => set('name', e.target.value)}
            autoComplete="off"
            aria-invalid={markInvalid && !form.name.trim()}
            style={markInvalid && !form.name.trim() ? { borderColor: 'var(--danger)' } : undefined}
          />
        </div>
      </div>
      <div className="form-group" style={{ marginBottom: '0.75rem' }}>
        <label style={{ fontSize: 13 }}>{t('settings.userMgmtEmail')}</label>
        <input
          className="input"
          type="email"
          value={form.email}
          onChange={e => set('email', e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="form-group" style={{ marginBottom: '0.75rem' }}>
        <label style={{ fontSize: 13 }}>
          {t('settings.userMgmtPassword')}
          {!isEdit && <span style={{ color: 'var(--text-muted)' }}> *</span>}
        </label>
        <div style={{ position: 'relative' }}>
          <input
            className="input"
            type={showPass ? 'text' : 'password'}
            value={form.password}
            onChange={e => set('password', e.target.value)}
            placeholder="••••••••"
            autoComplete="new-password"
            aria-invalid={markInvalid && !form.password.trim()}
            style={{
              paddingRight: '2.5rem',
              ...(markInvalid && !form.password.trim() ? { borderColor: 'var(--danger)' } : {}),
            }}
          />
          <button
            type="button"
            style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}
            onClick={() => setShowPass(v => !v)}
          >
            {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        {isEdit && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            {t('settings.userMgmtPasswordEditHint')}
          </div>
        )}
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', marginBottom: '1rem' }}>
        <input
          type="checkbox"
          checked={form.isAdmin}
          onChange={e => set('isAdmin', e.target.checked)}
        />
        <Shield size={14} />
        {t('settings.userMgmtRoleAdmin')}
      </label>
      <div className="form-group" style={{ marginBottom: '1rem' }}>
        <label style={{ fontSize: 13, marginBottom: 6, display: 'block' }}>
          {t('settings.userMgmtLibraries')}
        </label>
        {form.isAdmin ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {t('settings.userMgmtLibrariesAdminHint')}
          </div>
        ) : libraries.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {t('settings.userMgmtLibrariesEmpty')}
          </div>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                maxHeight: 180,
                overflowY: 'auto',
                padding: '6px 8px',
                border: `1px solid ${form.libraryIds.length === 0 ? 'var(--danger)' : 'var(--border)'}`,
                borderRadius: 6,
              }}
            >
              {libraries.map(lib => (
                <label
                  key={lib.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', padding: '2px 0' }}
                >
                  <input
                    type="checkbox"
                    checked={form.libraryIds.includes(lib.id)}
                    onChange={() => toggleLib(lib.id)}
                  />
                  {lib.name}
                </label>
              ))}
            </div>
            {form.libraryIds.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>
                {t('settings.userMgmtLibrariesValidation')}
              </div>
            )}
          </>
        )}
      </div>
      {!form.isAdmin && !isEdit && onSaveAndGetMagic && shareServerUrl.trim() && ndToken.trim() && (
        <div style={{ marginBottom: '1rem' }}>
          <div
            role="note"
            style={{
              fontSize: 11,
              lineHeight: 1.45,
              marginBottom: 10,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 35%, transparent)',
              background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 10%, transparent)',
              color: 'var(--text-primary)',
            }}
          >
            {t('settings.userMgmtMagicStringPlaintextWarning')}
          </div>
          <button
            type="button"
            className="btn btn-surface"
            onClick={() => void runSaveAndGetMagic()}
            disabled={busy || magicGenBusy}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            <Wand2 size={16} />
            {t('settings.userMgmtSaveAndMagicString')}
          </button>
        </div>
      )}
      {!form.isAdmin && isEdit && shareServerUrl.trim() && form.password.trim().length > 0 && ndToken.trim() && (
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.45 }}>
            {t('settings.userMgmtMagicStringPasswordNavHint')}
          </div>
          <div
            role="note"
            style={{
              fontSize: 11,
              lineHeight: 1.45,
              marginBottom: 10,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid color-mix(in srgb, var(--color-warning, #f59e0b) 35%, transparent)',
              background: 'color-mix(in srgb, var(--color-warning, #f59e0b) 10%, transparent)',
              color: 'var(--text-primary)',
            }}
          >
            {t('settings.userMgmtMagicStringPlaintextWarning')}
          </div>
          <button
            type="button"
            className="btn btn-surface"
            onClick={() => void generateMagicString()}
            disabled={busy || magicGenBusy}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            <Wand2 size={16} />
            {t('settings.userMgmtMagicStringGenerate')}
          </button>
        </div>
      )}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          {t('settings.userMgmtCancel')}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => trySave()}
          disabled={busy || (isEdit && !canSave)}
        >
          {t('settings.userMgmtSave')}
        </button>
      </div>
    </div>
  );
}
