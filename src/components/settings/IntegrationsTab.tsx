import { useTranslation } from 'react-i18next';
import { AlertTriangle, Info, Sparkles, Wifi } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import SettingsSubSection from '../SettingsSubSection';
import { SettingsGroup } from './SettingsGroup';
import { SettingsToggle } from './SettingsToggle';
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
          <div
            style={{ fontWeight: 700, fontSize: 13, lineHeight: 1.5, marginBottom: 'var(--space-3)', color: 'var(--text-secondary)' }}
          >
            {t('settings.discordRichPresenceNotice')}
          </div>
          <SettingsGroup title={t('settings.discordRichPresence')}>
            <SettingsToggle
              desc={t('settings.discordRichPresenceDesc')}
              ariaLabel={t('settings.discordRichPresence')}
              checked={auth.discordRichPresence}
              onChange={auth.setDiscordRichPresence}
            />
          </SettingsGroup>
          {auth.discordRichPresence && (
            <>
              <SettingsGroup title={t('settings.discordCoverTitle')} desc={t('settings.discordCoverDesc')}>
                <SettingsToggle
                  label={t('settings.discordCoverNone')}
                  checked={auth.discordCoverSource === 'none'}
                  onChange={c => auth.setDiscordCoverSource(c ? 'none' : 'server')}
                />
                <div className="settings-section-divider" />
                <SettingsToggle
                  label={t('settings.discordCoverServer')}
                  checked={auth.discordCoverSource === 'server'}
                  onChange={c => auth.setDiscordCoverSource(c ? 'server' : 'none')}
                />
                <div className="settings-section-divider" />
                <SettingsToggle
                  label={t('settings.discordCoverApple')}
                  checked={auth.discordCoverSource === 'apple'}
                  onChange={c => auth.setDiscordCoverSource(c ? 'apple' : 'none')}
                />
              </SettingsGroup>

              <SettingsGroup title={t('settings.discordTemplates')} desc={t('settings.discordTemplatesDesc')}>
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
              </SettingsGroup>
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
          <SettingsGroup>
            <SettingsToggle
              desc={t('settings.enableBandsintownDesc')}
              ariaLabel={t('settings.enableBandsintown')}
              checked={auth.enableBandsintown}
              onChange={auth.setEnableBandsintown}
            />
          </SettingsGroup>
        </div>
      </SettingsSubSection>

      {/* Now-Playing Share (Navidrome) */}
      <SettingsSubSection
        title={t('settings.nowPlayingEnabled')}
        icon={<Wifi size={16} />}
      >
        <div className="settings-card">
          <SettingsGroup>
            <SettingsToggle
              desc={t('settings.nowPlayingEnabledDesc')}
              note={t('settings.nowPlayingPluginNote')}
              ariaLabel={t('settings.nowPlayingEnabled')}
              checked={auth.nowPlayingEnabled}
              onChange={auth.setNowPlayingEnabled}
            />
          </SettingsGroup>
        </div>
      </SettingsSubSection>
    </>
  );
}
