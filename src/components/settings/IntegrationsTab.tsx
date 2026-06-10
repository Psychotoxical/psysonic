import { useTranslation } from 'react-i18next';
import { AlertTriangle, Info, Sparkles, Wifi } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import SettingsSubSection from '../SettingsSubSection';
import { MusicNetworkSection } from './musicNetwork/MusicNetworkSection';

export function IntegrationsTab() {
  const { t } = useTranslation();
  const auth = useAuthStore();

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

      {/* Music Network — scrobbling + enrichment across multiple services */}
      <MusicNetworkSection />

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
                  <label style={{ fontSize: 12 }}>{t('settings.discordTemplateName')}</label>
                  <input
                    className="input"
                    type="text"
                    value={auth.discordTemplateName}
                    onChange={e => auth.setDiscordTemplateName(e.target.value)}
                    placeholder="{title}"
                  />
                </div>
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
