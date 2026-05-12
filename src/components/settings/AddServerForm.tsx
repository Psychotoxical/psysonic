import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import type { ServerProfile } from '../../store/authStoreTypes';
import { showToast } from '../../utils/toast';
import {
  decodeServerMagicString,
  encodeServerMagicString,
  DECODED_PASSWORD_VISUAL_MASK,
  type ServerMagicPayload,
} from '../../utils/serverMagicString';
import { shortHostFromServerUrl } from '../../utils/serverDisplayName';

export function AddServerForm({
  onSave,
  onCancel,
  initialInvite = null,
}: {
  onSave: (data: Omit<ServerProfile, 'id'>) => void;
  onCancel: () => void;
  initialInvite?: ServerMagicPayload | null;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: '', url: '', username: '', password: '' });
  const [magicString, setMagicString] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [blockPasswordReveal, setBlockPasswordReveal] = useState(false);

  useEffect(() => {
    if (!initialInvite) return;
    setShowPass(false);
    setBlockPasswordReveal(true);
    setForm({
      name: (initialInvite.name && initialInvite.name.trim()) || shortHostFromServerUrl(initialInvite.url),
      url: initialInvite.url,
      username: initialInvite.username,
      password: initialInvite.password,
    });
    setMagicString(encodeServerMagicString(initialInvite));
  }, [initialInvite]);

  const update = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const handleMagicStringChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setMagicString(v);
    const trimmed = v.trim();
    const decoded = decodeServerMagicString(trimmed);
    if (decoded) {
      setShowPass(false);
      setBlockPasswordReveal(true);
      setForm({
        name: (decoded.name && decoded.name.trim()) || shortHostFromServerUrl(decoded.url),
        url: decoded.url,
        username: decoded.username,
        password: decoded.password,
      });
    }
  };

  const submit = () => {
    const ms = magicString.trim();
    if (ms) {
      const decoded = decodeServerMagicString(ms);
      if (!decoded) {
        showToast(t('login.magicStringInvalid'), 4000, 'error');
        return;
      }
      onSave({
        name: form.name.trim() || (decoded.name && decoded.name.trim()) || shortHostFromServerUrl(decoded.url),
        url: decoded.url,
        username: decoded.username,
        password: decoded.password,
      });
      return;
    }
    if (!form.url.trim()) return;
    onSave({
      name: form.name.trim() || form.url.trim(),
      url: form.url.trim(),
      username: form.username.trim(),
      password: form.password,
    });
  };

  return (
    <div className="settings-card" style={{ marginTop: '1rem' }}>
      <h3 style={{ fontWeight: 600, marginBottom: '1rem', fontSize: '14px' }}>{t('settings.addServerTitle')}</h3>
      <div className="form-group" style={{ marginBottom: '0.75rem' }}>
        <label style={{ fontSize: 13 }}>{t('settings.serverName')}</label>
        <input className="input" type="text" value={form.name} onChange={update('name')} placeholder="My Navidrome" autoComplete="off" />
      </div>
      <div className="form-group" style={{ marginBottom: '0.75rem' }}>
        <label style={{ fontSize: 13 }}>{t('settings.serverUrl')}</label>
        <input className="input" type="text" value={form.url} onChange={update('url')} placeholder={t('settings.serverUrlPlaceholder')} autoComplete="off" />
      </div>
      <div className="form-row" style={{ marginBottom: '0.75rem' }}>
        <div className="form-group">
          <label style={{ fontSize: 13 }}>{t('settings.serverUsername')}</label>
          <input
            className="input"
            type="text"
            value={form.username}
            onChange={update('username')}
            placeholder="admin"
            autoComplete="off"
            readOnly={blockPasswordReveal}
            style={blockPasswordReveal ? { cursor: 'default' } : undefined}
          />
        </div>
        <div className="form-group">
          <label style={{ fontSize: 13 }}>{t('settings.serverPassword')}</label>
          {blockPasswordReveal ? (
            <input
              className="input"
              type="text"
              readOnly
              value={DECODED_PASSWORD_VISUAL_MASK}
              autoComplete="off"
              aria-label={t('settings.serverPassword')}
              style={{ letterSpacing: '0.12em', cursor: 'default' }}
            />
          ) : (
            <div style={{ position: 'relative' }}>
              <input
                className="input"
                type={showPass ? 'text' : 'password'}
                value={form.password}
                onChange={update('password')}
                placeholder="••••••••"
                style={{ paddingRight: '2.5rem' }}
              />
              <button
                type="button"
                style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}
                onClick={() => setShowPass(v => !v)}
              >
                {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="form-group" style={{ marginBottom: '0.75rem' }}>
        <label style={{ fontSize: 13 }}>{t('login.orMagicString')}</label>
        <input
          className="input"
          type="text"
          value={magicString}
          onChange={handleMagicStringChange}
          placeholder={t('login.magicStringPlaceholder')}
          autoComplete="off"
        />
      </div>
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onCancel}>{t('common.cancel')}</button>
        <button
          className="btn btn-primary"
          onClick={submit}
        >
          {t('common.add')}
        </button>
      </div>
    </div>
  );
}
