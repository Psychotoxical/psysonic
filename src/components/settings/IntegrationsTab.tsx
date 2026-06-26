import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Image as ImageIcon, Info, Sparkles, Wifi } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { useThemeStore } from '../../store/themeStore';
import SettingsSubSection from '../SettingsSubSection';
import { SettingsGroup } from './SettingsGroup';
import { SettingsToggle } from './SettingsToggle';
import { SettingsSubCard, SettingsField } from './SettingsSubCard';
import { BackdropSourceList } from './BackdropSourceList';
import type { BackdropSurface } from '../../store/themeStore';
import type { BackdropSource } from '../../cover/artistBackdrop';
import { MusicNetworkSection } from './musicNetwork/MusicNetworkSection';
import { purgeExternalArtworkAllServers } from '../../api/coverCache';

export function IntegrationsTab() {
  const { t } = useTranslation();
  const auth = useAuthStore();
  const theme = useThemeStore();

  const backdropSurfaces: { key: BackdropSurface; label: string }[] = [
    { key: 'mainstageHero', label: t('settings.backdropSurfaceMainstage') },
    { key: 'artistDetailHero', label: t('settings.backdropSurfaceArtistDetail') },
    { key: 'fullscreenPlayer', label: t('settings.backdropSurfaceFullscreen') },
  ];
  const backdropSourceLabel = (s: BackdropSource): string =>
    s === 'banner'
      ? t('settings.backdropSourceBanner')
      : s === 'fanart'
        ? t('settings.backdropSourceFanart')
        : t('settings.backdropSourceNavidrome');

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
                <SettingsSubCard>
                  <SettingsField label={t('settings.discordTemplateName')}>
                    <input
                      className="input"
                      type="text"
                      value={auth.discordTemplateName}
                      onChange={e => auth.setDiscordTemplateName(e.target.value)}
                      placeholder="{title}"
                    />
                  </SettingsField>
                  <SettingsField label={t('settings.discordTemplateDetails')}>
                    <input
                      className="input"
                      type="text"
                      value={auth.discordTemplateDetails}
                      onChange={e => auth.setDiscordTemplateDetails(e.target.value)}
                      placeholder="{artist}"
                    />
                  </SettingsField>
                  <SettingsField label={t('settings.discordTemplateState')}>
                    <input
                      className="input"
                      type="text"
                      value={auth.discordTemplateState}
                      onChange={e => auth.setDiscordTemplateState(e.target.value)}
                      placeholder="{title}"
                    />
                  </SettingsField>
                  <SettingsField label={t('settings.discordTemplateLargeText')}>
                    <input
                      className="input"
                      type="text"
                      value={auth.discordTemplateLargeText}
                      onChange={e => auth.setDiscordTemplateLargeText(e.target.value)}
                      placeholder="{album}"
                    />
                  </SettingsField>
                </SettingsSubCard>
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

      {/* External artist artwork (fanart.tv) */}
      <SettingsSubSection
        title={t('settings.externalArtwork')}
        icon={<ImageIcon size={16} />}
      >
        <div className="settings-card">
          <SettingsGroup>
            <SettingsToggle
              desc={t('settings.externalArtworkDesc')}
              note={t('settings.externalArtworkNote')}
              ariaLabel={t('settings.externalArtwork')}
              checked={theme.externalArtworkEnabled}
              onChange={v => {
                theme.setExternalArtworkEnabled(v);
                // Opt-out: purge the fetched external images + lookup rows so
                // turning the scraper off actually removes the third-party data,
                // not just hides it (design-review §9/§12/B.4).
                if (!v) void purgeExternalArtworkAllServers();
              }}
            />
          </SettingsGroup>
          {theme.externalArtworkEnabled && (
            <SettingsGroup
              title={t('settings.externalArtworkByokTitle')}
              desc={t('settings.externalArtworkByokDesc')}
            >
              <SettingsSubCard>
                <SettingsField>
                  <input
                    className="input"
                    type="password"
                    value={theme.externalArtworkByok}
                    onChange={e => theme.setExternalArtworkByok(e.target.value)}
                    placeholder="fanart.tv personal API key"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  {theme.externalArtworkByok.trim() && (
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--text-muted)',
                        marginTop: 6,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      <Check size={13} /> {t('settings.externalArtworkByokSaved')}
                    </div>
                  )}
                </SettingsField>
              </SettingsSubCard>
            </SettingsGroup>
          )}
          {theme.externalArtworkEnabled && (
            <SettingsGroup
              title={t('settings.backdropSourcesTitle')}
              desc={t('settings.backdropSourcesSub')}
            >
              <SettingsSubCard>
                {backdropSurfaces.map(({ key, label }) => (
                  <div className="backdrop-surface-block" key={key}>
                    <SettingsToggle
                      label={label}
                      checked={theme.backdrops[key].enabled}
                      onChange={(v) => theme.setBackdropEnabled(key, v)}
                    />
                    {theme.backdrops[key].enabled && (
                      <BackdropSourceList
                        surface={key}
                        sources={theme.backdrops[key].sources}
                        labelFor={backdropSourceLabel}
                        onChange={(next) => theme.setBackdropSources(key, next)}
                        moveUpLabel={t('settings.backdropMoveUp')}
                        moveDownLabel={t('settings.backdropMoveDown')}
                      />
                    )}
                  </div>
                ))}
              </SettingsSubCard>
            </SettingsGroup>
          )}
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
