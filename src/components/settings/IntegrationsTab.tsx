import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Info, Sparkles, Wifi } from 'lucide-react';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { lastfmAuthUrl, lastfmGetSession, lastfmGetToken, lastfmGetUserInfo, type LastfmUserInfo } from '../../api/lastfm';
import { useAuthStore } from '../../store/authStore';
import LastfmIcon from '../LastfmIcon';
import SettingsSubSection from '../SettingsSubSection';

export function IntegrationsTab() {
  const { t } = useTranslation();
  const auth = useAuthStore();
  const [lfmState, setLfmState] = useState<'idle' | 'waiting' | 'error'>('idle');
  // Polled token is kept here in case future flows need to display or cancel it explicitly.
  const [, setLfmPendingToken] = useState<string | null>(null);
  const [lfmError, setLfmError] = useState<string | null>(null);
  const [lfmUserInfo, setLfmUserInfo] = useState<LastfmUserInfo | null>(null);

  useEffect(() => {
    if (!auth.lastfmSessionKey || !auth.lastfmUsername) { setLfmUserInfo(null); return; }
    lastfmGetUserInfo(auth.lastfmUsername, auth.lastfmSessionKey).then(setLfmUserInfo).catch(() => {});
  }, [auth.lastfmSessionKey, auth.lastfmUsername]);

  const startLastfmConnect = useCallback(async () => {
    setLfmError(null);
    let token: string;
    try {
      token = await lastfmGetToken();
      setLfmPendingToken(token);
      setLfmState('waiting');
      await openUrl(lastfmAuthUrl(token));
    } catch (e: any) {
      setLfmError(e.message ?? 'Unknown error');
      setLfmState('error');
      return;
    }

    // Poll every 2 s until the user authorises or we time out (2 min)
    const deadline = Date.now() + 120_000;
    const poll = async () => {
      if (Date.now() > deadline) {
        setLfmState('error');
        setLfmError('Timed out — please try again.');
        setLfmPendingToken(null);
        return;
      }
      try {
        const { key, name } = await lastfmGetSession(token);
        auth.connectLastfm(key, name);
        setLfmState('idle');
        setLfmPendingToken(null);
      } catch (e: any) {
        // Error 14 = not yet authorised, keep polling
        if (e.message?.includes('14')) {
          setTimeout(poll, 2000);
        } else {
          setLfmState('error');
          setLfmError(e.message ?? 'Unknown error');
          setLfmPendingToken(null);
        }
      }
    };
    setTimeout(poll, 2000);
  }, [auth]);

  return (
    <>
      <div
        className="settings-privacy-notice"
        role="note"
        aria-label={t('settings.integrationsPrivacyTitle')}
      >
        <AlertTriangle size={16} className="settings-privacy-notice-icon" aria-hidden="true" />
        <div>
          <div className="settings-privacy-notice-title">{t('settings.integrationsPrivacyTitle')}</div>
          <div
            className="settings-privacy-notice-body"
            // Enthaelt <strong> aus dem i18n-String — der Inhalt ist statisch
            // und kommt nur aus unseren Locales, kein User-Input.
            dangerouslySetInnerHTML={{ __html: t('settings.integrationsPrivacyBody') }}
          />
        </div>
      </div>

      {/* Last.fm */}
      <SettingsSubSection
        title={t('settings.lfmTitle')}
        icon={<LastfmIcon size={16} />}
      >
        <div className="settings-card">
          {auth.lastfmSessionKey ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1rem', borderRadius: '10px', background: 'color-mix(in srgb, var(--accent) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 20%, transparent)' }}>
                <div style={{ flexShrink: 0, color: '#e31c23' }}><LastfmIcon size={20} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>@{auth.lastfmUsername}</div>
                  {lfmUserInfo && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, display: 'flex', gap: '0.75rem' }}>
                      <span>{t('settings.lfmScrobbles', { n: lfmUserInfo.playcount.toLocaleString() })}</span>
                      <span>{t('settings.lfmMemberSince', { year: new Date(lfmUserInfo.registeredAt * 1000).getFullYear() })}</span>
                    </div>
                  )}
                </div>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: 12, padding: '4px 10px', flexShrink: 0 }}
                  onClick={() => auth.disconnectLastfm()}
                >
                  {t('settings.lfmDisconnect')}
                </button>
              </div>
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.scrobbleEnabled')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.scrobbleDesc')}</div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.scrobbleEnabled')}>
                  <input type="checkbox" checked={auth.scrobblingEnabled} onChange={e => auth.setScrobblingEnabled(e.target.checked)} id="scrobbling-toggle" />
                  <span className="toggle-track" />
                </label>
              </div>
            </div>
          ) : lfmState === 'waiting' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: 13, color: 'var(--text-secondary)' }}>
                <div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
                {t('settings.lfmConnecting')}
              </div>
              <button className="btn btn-ghost" style={{ alignSelf: 'flex-start', fontSize: 12 }}
                onClick={() => { setLfmState('idle'); setLfmPendingToken(null); }}>
                {t('common.cancel')}
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                {t('settings.lfmConnectDesc')}
              </p>
              {lfmState === 'error' && (
                <p style={{ fontSize: 12, color: 'var(--danger)' }}>{lfmError}</p>
              )}
              <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={startLastfmConnect}>
                {t('settings.lfmConnect')}
              </button>
            </div>
          )}
        </div>
      </SettingsSubSection>

      {/* Discord Rich Presence */}
      <SettingsSubSection
        title={t('settings.discordRichPresence')}
        icon={<Sparkles size={16} />}
      >
        <div className="settings-card">
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.discordRichPresence')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.discordRichPresenceDesc')}</div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.discordRichPresence')}>
              <input type="checkbox" checked={auth.discordRichPresence} onChange={e => auth.setDiscordRichPresence(e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </div>
          {auth.discordRichPresence && (
            <>
              <div className="settings-toggle-row" style={{ padding: '4px var(--space-3) 4px var(--space-6)', fontSize: 13 }}>
                <div style={{ fontWeight: 500 }}>{t('settings.discordCoverNone')}</div>
                <label className="toggle-switch" aria-label={t('settings.discordCoverNone')}>
                  <input
                    type="checkbox"
                    checked={auth.discordCoverSource === 'none'}
                    onChange={e => auth.setDiscordCoverSource(e.target.checked ? 'none' : 'server')}
                  />
                  <span className="toggle-track" />
                </label>
              </div>
              <div className="settings-toggle-row" style={{ padding: '4px var(--space-3) 4px var(--space-6)', fontSize: 13 }}>
                <div style={{ fontWeight: 500 }}>{t('settings.discordCoverServer')}</div>
                <label className="toggle-switch" aria-label={t('settings.discordCoverServer')}>
                  <input
                    type="checkbox"
                    checked={auth.discordCoverSource === 'server'}
                    onChange={e => auth.setDiscordCoverSource(e.target.checked ? 'server' : 'none')}
                  />
                  <span className="toggle-track" />
                </label>
              </div>
              <div className="settings-toggle-row" style={{ padding: '4px var(--space-3) 4px var(--space-6)', fontSize: 13 }}>
                <div style={{ fontWeight: 500 }}>{t('settings.discordCoverApple')}</div>
                <label className="toggle-switch" aria-label={t('settings.discordCoverApple')}>
                  <input
                    type="checkbox"
                    checked={auth.discordCoverSource === 'apple'}
                    onChange={e => auth.setDiscordCoverSource(e.target.checked ? 'apple' : 'none')}
                  />
                  <span className="toggle-track" />
                </label>
              </div>
              <div className="settings-section-divider" />
              <div style={{ paddingTop: 8 }}>
                <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 8 }}>{t('settings.discordTemplates')}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>{t('settings.discordTemplatesDesc')}</div>
                <div className="form-group" style={{ marginBottom: '0.75rem' }}>
                  <label style={{ fontSize: 12 }}>{t('settings.discordTemplateDetails')}</label>
                  <input
                    className="input"
                    type="text"
                    value={auth.discordTemplateDetails}
                    onChange={e => auth.setDiscordTemplateDetails(e.target.value)}
                    placeholder="{artist}"
                  />
                </div>
                <div className="form-group" style={{ marginBottom: '0.75rem' }}>
                  <label style={{ fontSize: 12 }}>{t('settings.discordTemplateState')}</label>
                  <input
                    className="input"
                    type="text"
                    value={auth.discordTemplateState}
                    onChange={e => auth.setDiscordTemplateState(e.target.value)}
                    placeholder="{title}"
                  />
                </div>
                <div className="form-group">
                  <label style={{ fontSize: 12 }}>{t('settings.discordTemplateLargeText')}</label>
                  <input
                    className="input"
                    type="text"
                    value={auth.discordTemplateLargeText}
                    onChange={e => auth.setDiscordTemplateLargeText(e.target.value)}
                    placeholder="{album}"
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </SettingsSubSection>

      {/* Bandsintown */}
      <SettingsSubSection
        title={t('settings.enableBandsintown')}
        icon={<Info size={16} />}
      >
        <div className="settings-card">
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.enableBandsintown')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.enableBandsintownDesc')}</div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.enableBandsintown')}>
              <input type="checkbox" checked={auth.enableBandsintown} onChange={e => auth.setEnableBandsintown(e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
      </SettingsSubSection>

      {/* Now-Playing Share (Navidrome) */}
      <SettingsSubSection
        title={t('settings.nowPlayingEnabled')}
        icon={<Wifi size={16} />}
      >
        <div className="settings-card">
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.nowPlayingEnabled')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.nowPlayingEnabledDesc')}</div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.nowPlayingEnabled')}>
              <input type="checkbox" checked={auth.nowPlayingEnabled} onChange={e => auth.setNowPlayingEnabled(e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
      </SettingsSubSection>
    </>
  );
}
