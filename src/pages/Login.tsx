import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Wifi, WifiOff, Eye, EyeOff, Server } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { pingWithCredentials, scheduleInstantMixProbeForServer } from '../api/subsonic';
import { useTranslation } from 'react-i18next';
import {
  decodeServerMagicString,
  DECODED_PASSWORD_VISUAL_MASK,
  encodeServerMagicString,
  type ServerMagicPayload,
} from '../utils/serverMagicString';
import { shortHostFromServerUrl, serverListDisplayLabel } from '../utils/serverDisplayName';

const PsysonicLogo = () => (
  <img src="/logo-psysonic.png" width="64" height="64" alt="Psysonic" style={{ borderRadius: 18 }} />
);

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { addServer, updateServer, setActiveServer, setLoggedIn, setConnecting, setConnectionError, servers } = useAuthStore();

  const [form, setForm] = useState({ serverName: '', url: '', username: '', password: '' });
  const [magicString, setMagicString] = useState('');
  const [showPass, setShowPass] = useState(false);
  /** After a valid magic string decode, do not allow revealing the password in the UI. */
  const [blockPasswordReveal, setBlockPasswordReveal] = useState(false);
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  useEffect(() => {
    const inv = (location.state as { openAddServerInvite?: ServerMagicPayload } | null)?.openAddServerInvite;
    if (!inv) return;
    setShowPass(false);
    setBlockPasswordReveal(true);
    setForm({
      serverName: (inv.name && inv.name.trim()) || shortHostFromServerUrl(inv.url),
      url: inv.url,
      username: inv.username,
      password: inv.password,
    });
    setMagicString(encodeServerMagicString(inv));
    navigate('/login', { replace: true, state: {} });
  }, [location.state, navigate]);

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
        serverName: (decoded.name && decoded.name.trim()) || shortHostFromServerUrl(decoded.url),
        url: decoded.url,
        username: decoded.username,
        password: decoded.password,
      });
      if (status === 'error') {
        setStatus('idle');
        setTestMessage('');
      }
    }
  };

  const attemptConnect = async (profile: { name: string; url: string; username: string; password: string }) => {
    if (!profile.url.trim()) {
      setTestMessage(t('login.urlRequired'));
      setStatus('error');
      return;
    }

    setStatus('testing');
    setTestMessage(t('login.connecting'));
    setConnecting(true);
    setConnectionError(null);

    // Test connection directly with entered credentials — don't touch the store yet.
    // This avoids any race condition with Zustand's async store rehydration.
    let ping: Awaited<ReturnType<typeof pingWithCredentials>> = { ok: false };
    try {
      ping = await pingWithCredentials(profile.url.trim(), profile.username.trim(), profile.password);
    } catch {
      ping = { ok: false };
    }

    setConnecting(false);

    if (ping.ok) {
      // Connection succeeded — now persist to store
      const existing = servers.find(s => s.url === profile.url.trim() && s.username === profile.username.trim());
      let serverId: string;
      if (existing) {
        updateServer(existing.id, {
          name: profile.name.trim() || profile.url.trim(),
          password: profile.password,
        });
        serverId = existing.id;
      } else {
        serverId = addServer({
          name: profile.name.trim() || profile.url.trim(),
          url: profile.url.trim(),
          username: profile.username.trim(),
          password: profile.password,
        });
      }
      const identity = {
        type: ping.type,
        serverVersion: ping.serverVersion,
        openSubsonic: ping.openSubsonic,
      };
      useAuthStore.getState().setSubsonicServerIdentity(serverId, identity);
      scheduleInstantMixProbeForServer(
        serverId,
        profile.url.trim(),
        profile.username.trim(),
        profile.password,
        identity,
      );
      setActiveServer(serverId);
      setLoggedIn(true);
      setStatus('ok');
      setTestMessage(t('login.connected'));
      setTimeout(() => navigate('/'), 600);
    } else {
      setStatus('error');
      setConnectionError(t('login.error'));
      setTestMessage(t('login.error'));
    }
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ms = magicString.trim();
    if (ms) {
      const decoded = decodeServerMagicString(ms);
      if (!decoded) {
        setStatus('error');
        setTestMessage(t('login.magicStringInvalid'));
        return;
      }
      await attemptConnect({
        name: form.serverName.trim() || (decoded.name && decoded.name.trim()) || shortHostFromServerUrl(decoded.url),
        url: decoded.url,
        username: decoded.username,
        password: decoded.password,
      });
      return;
    }
    await attemptConnect({ name: form.serverName, url: form.url, username: form.username, password: form.password });
  };

  const handleQuickConnect = async (srv: typeof servers[0]) => {
    setMagicString('');
    setBlockPasswordReveal(false);
    setShowPass(false);
    setForm({ serverName: srv.name, url: srv.url, username: srv.username, password: srv.password });
    await attemptConnect({ name: srv.name, url: srv.url, username: srv.username, password: srv.password });
  };

  return (
    <div className="login-page">
      <div className="login-bg" aria-hidden="true" />
      <div className="login-card animate-fade-in">
        <div className="login-logo">
          <PsysonicLogo />
        </div>
        <h1 className="login-title">Psysonic</h1>
        <p className="login-subtitle">{t('login.subtitle')}</p>

        {/* Saved servers quick-connect */}
        {servers.length > 0 && (
          <div className="login-saved-servers">
            <div className="login-saved-label">{t('login.savedServers')}</div>
            {servers.map(srv => (
              <button
                key={srv.id}
                className="btn btn-surface login-server-btn"
                onClick={() => handleQuickConnect(srv)}
                disabled={status === 'testing'}
              >
                <Server size={14} style={{ flexShrink: 0 }} />
                <div style={{ textAlign: 'left', minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }} className="truncate">{serverListDisplayLabel(srv, servers)}</div>
                  <div style={{ fontSize: 11, opacity: 0.7 }} className="truncate">{srv.username}@{srv.url}</div>
                </div>
              </button>
            ))}
            <div className="login-divider"><span>{t('login.addNew')}</span></div>
          </div>
        )}

        <form className="login-form" onSubmit={handleFormSubmit} noValidate>
          <div className="form-group">
            <label htmlFor="login-server-name">{t('login.serverName')}</label>
            <input
              id="login-server-name"
              className="input"
              type="text"
              placeholder={t('login.serverNamePlaceholder')}
              value={form.serverName}
              onChange={update('serverName')}
              autoComplete="off"
            />
          </div>

          <div className="form-group">
            <label htmlFor="login-url">{t('login.serverUrl')}</label>
            <input
              id="login-url"
              className="input"
              type="text"
              placeholder={t('login.serverUrlPlaceholder')}
              value={form.url}
              onChange={update('url')}
              autoComplete="off"
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="login-username">{t('login.username')}</label>
              <input
                id="login-username"
                className="input"
                type="text"
                placeholder={t('login.usernamePlaceholder')}
                value={form.username}
                onChange={update('username')}
                readOnly={blockPasswordReveal}
                autoComplete="username"
                style={blockPasswordReveal ? { cursor: 'default' } : undefined}
              />
            </div>
            <div className="form-group">
              <label htmlFor={blockPasswordReveal ? 'login-password-mask' : 'login-password'}>{t('login.password')}</label>
              {blockPasswordReveal ? (
                <input
                  id="login-password-mask"
                  className="input"
                  type="text"
                  readOnly
                  value={DECODED_PASSWORD_VISUAL_MASK}
                  autoComplete="off"
                  aria-label={t('login.password')}
                  style={{ letterSpacing: '0.12em', cursor: 'default' }}
                />
              ) : (
                <div style={{ position: 'relative' }}>
                  <input
                    id="login-password"
                    className="input"
                    type={showPass ? 'text' : 'password'}
                    placeholder="••••••••"
                    value={form.password}
                    onChange={update('password')}
                    autoComplete="current-password"
                    style={{ paddingRight: '2.5rem' }}
                  />
                  <button
                    type="button"
                    style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}
                    onClick={() => setShowPass(v => !v)}
                    aria-label={showPass ? t('login.hidePassword') : t('login.showPassword')}
                  >
                    {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="login-magic-string">{t('login.orMagicString')}</label>
            <input
              id="login-magic-string"
              className="input"
              type="text"
              placeholder={t('login.magicStringPlaceholder')}
              value={magicString}
              onChange={handleMagicStringChange}
              autoComplete="off"
            />
          </div>

          {testMessage && (
            <div className={`login-status login-status--${status}`} role="alert">
              {status === 'testing' && <div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />}
              {status === 'ok' && <Wifi size={16} />}
              {status === 'error' && <WifiOff size={16} />}
              <span>{testMessage}</span>
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: '100%', justifyContent: 'center', padding: '0.75rem', fontSize: '15px' }}
            id="login-connect-btn"
            disabled={status === 'testing'}
          >
            {status === 'testing' ? t('login.connecting') : t('login.connect')}
          </button>
        </form>
      </div>
    </div>
  );
}
