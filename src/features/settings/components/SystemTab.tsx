import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { commands } from '@/generated/bindings';
import { linuxWaylandTextRenderSettingsAvailable } from '@/lib/api/platformShell';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { AppWindow, ChevronDown, Download, ExternalLink, Globe, HardDrive, Info, Scale, Sliders, Users } from 'lucide-react';
import { version as appVersion } from '@/../package.json';
import i18n from '@/lib/i18n';
import { useAuthStore } from '@/store/authStore';
import type { ClockFormat, LinuxWaylandTextRenderProfile, LoggingMode } from '@/store/authStoreTypes';
import { IS_LINUX } from '@/lib/util/platform';
import { showToast } from '@/lib/dom/toast';
import { AboutPsysonicBrandHeader } from '@/features/settings/components/AboutPsysonicLol';
import CustomSelect from '@/ui/CustomSelect';
import LicensesPanel from '@/features/settings/components/LicensesPanel';
import SettingsSubSection from '@/features/settings/components/SettingsSubSection';
import { SettingsGroup } from '@/features/settings/components/SettingsGroup';
import { SettingsToggle } from '@/features/settings/components/SettingsToggle';
import { SettingsSubCard, SettingsField } from '@/features/settings/components/SettingsSubCard';
import { BackupSection } from '@/features/settings/components/BackupSection';
import { CONTRIBUTORS, MAINTAINERS, themeContributorsFromRegistry, type ThemeContributor } from '@/config/settingsCredits';
import { fetchRegistry } from '@/lib/themes/themeRegistry';

export function SystemTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const auth = useAuthStore();
  const [waylandTextRenderAvailable, setWaylandTextRenderAvailable] = useState(false);
  const [themeContributors, setThemeContributors] = useState<ThemeContributor[]>([]);

  useEffect(() => {
    if (!IS_LINUX) return;
    linuxWaylandTextRenderSettingsAvailable()
      .then(setWaylandTextRenderAvailable)
      .catch(() => {});
  }, []);

  // Community theme authors come from the store registry (cached, offline-safe).
  // On a first run with no cached registry this simply stays empty.
  useEffect(() => {
    let cancelled = false;
    fetchRegistry()
      .then(({ registry }) => {
        if (!cancelled) setThemeContributors(themeContributorsFromRegistry(registry.themes));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const exportRuntimeLogs = async () => {
    const suggestedName = `psysonic-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    const selected = await saveDialog({
      defaultPath: suggestedName,
      filters: [{ name: 'Log files', extensions: ['log', 'txt'] }],
      title: t('settings.loggingExport'),
    });
    if (!selected || Array.isArray(selected)) return;
    try {
      const res = await commands.exportRuntimeLogs(selected);
      if (res.status === 'error') throw new Error(res.error);
      showToast(t('settings.loggingExportSuccess', { count: res.data }), 3500, 'info');
    } catch (e) {
      console.error(e);
      showToast(t('settings.loggingExportError'), 4500, 'error');
    }
  };

  // Shared card for both credit sub-sections: avatar + @handle link, a sub-line,
  // and an expandable list (code contributions for App, theme names for Themes).
  const renderContributorCard = (github: string, sub: ReactNode, items: readonly string[]) => (
    <details key={github} className="contributor-card">
      <summary className="contributor-card-summary">
        <img
          src={`https://github.com/${github}.png?size=48`}
          width={32}
          height={32}
          className="contributor-card-avatar"
          alt={github}
        />
        <div className="contributor-card-meta">
          <span
            className="contributor-card-name"
            role="button"
            tabIndex={0}
            onClick={e => { e.stopPropagation(); openUrl(`https://github.com/${github}`); }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                e.preventDefault();
                openUrl(`https://github.com/${github}`);
              }
            }}
          >
            @{github}
          </span>
          <span className="contributor-card-sub">{sub}</span>
        </div>
        <ChevronDown size={14} className="contributor-card-chevron" aria-hidden />
      </summary>
      <ul className="contributor-card-list">
        {items.map(item => <li key={item}>{item}</li>)}
      </ul>
    </details>
  );

  return (
    <>
      <SettingsSubSection
        title={t('settings.language')}
        icon={<Globe size={16} />}
      >
        <div className="settings-card">
          <SettingsGroup>
            <SettingsSubCard>
              <SettingsField>
                <CustomSelect
                  value={i18n.language}
                  onChange={v => i18n.changeLanguage(v)}
                  options={[
                    { value: 'en', label: t('settings.languageEn') },
                    { value: 'de', label: t('settings.languageDe') },
                    { value: 'es', label: t('settings.languageEs') },
                    { value: 'fr', label: t('settings.languageFr') },
                    { value: 'it', label: t('settings.languageIt') },
                    { value: 'nl', label: t('settings.languageNl') },
                    { value: 'nb', label: t('settings.languageNb') },
                    { value: 'ru', label: t('settings.languageRu') },
                    { value: 'zh', label: t('settings.languageZh') },
                    { value: 'ro', label: t('settings.languageRo') },
                    { value: 'ja', label: t('settings.languageJa') },
                    { value: 'hu', label: t('settings.languageHu') },
                    { value: 'pl', label: t('settings.languagePl') },
                    { value: 'bg', label: t('settings.languageBg') },
                  ]}
                />
              </SettingsField>
            </SettingsSubCard>
          </SettingsGroup>
        </div>
      </SettingsSubSection>

      {/* App-Verhalten (aus altem library/general Behavior-Block) */}
      <SettingsSubSection
        title={t('settings.behavior')}
        icon={<AppWindow size={16} />}
      >
        <div className="settings-card">
          <SettingsGroup title={t('settings.groupTray')}>
            <SettingsToggle
              label={t('settings.showTrayIcon')}
              desc={t('settings.showTrayIconDesc')}
              checked={auth.showTrayIcon}
              onChange={auth.setShowTrayIcon}
            />
            <div className="settings-section-divider" />
            <SettingsToggle
              label={t('settings.minimizeToTray')}
              desc={t('settings.minimizeToTrayDesc')}
              checked={auth.minimizeToTray}
              onChange={auth.setMinimizeToTray}
            />
          </SettingsGroup>

          {IS_LINUX && (
            <SettingsGroup title={t('settings.groupLinuxRendering')}>
              <SettingsToggle
                label={t('settings.linuxWebkitSmoothScroll')}
                desc={t('settings.linuxWebkitSmoothScrollDesc')}
                checked={auth.linuxWebkitKineticScroll}
                onChange={auth.setLinuxWebkitKineticScroll}
              />
              <div className="settings-section-divider" />
              <SettingsToggle
                label={t('settings.linuxWebkitInputForceRepaint')}
                desc={t('settings.linuxWebkitInputForceRepaintDesc')}
                checked={auth.linuxWebkitInputForceRepaint}
                onChange={auth.setLinuxWebkitInputForceRepaint}
              />
              {waylandTextRenderAvailable && (
                <SettingsSubCard style={{ marginTop: '0.85rem' }}>
                  <SettingsField
                    label={t('settings.linuxWaylandTextRender')}
                    desc={t('settings.linuxWaylandTextRenderDesc')}
                  >
                    <CustomSelect
                      value={auth.linuxWaylandTextRenderProfile}
                      onChange={v => auth.setLinuxWaylandTextRenderProfile(v as LinuxWaylandTextRenderProfile)}
                      options={[
                        { value: 'balanced', label: t('settings.linuxWaylandTextRenderBalanced') },
                        { value: 'sharp', label: t('settings.linuxWaylandTextRenderSharp') },
                        { value: 'gpu', label: t('settings.linuxWaylandTextRenderGpu') },
                        { value: 'minimal', label: t('settings.linuxWaylandTextRenderMinimal') },
                      ]}
                    />
                  </SettingsField>
                </SettingsSubCard>
              )}
            </SettingsGroup>
          )}

          <SettingsGroup title={t('settings.groupClock')}>
            <SettingsSubCard>
              <SettingsField label={t('settings.clockFormat')} desc={t('settings.clockFormatDesc')} row>
                <div style={{ minWidth: 160 }}>
                  <CustomSelect
                    value={auth.clockFormat}
                    onChange={(v) => auth.setClockFormat(v as ClockFormat)}
                    options={[
                      { value: 'auto', label: t('settings.clockFormatAuto') },
                      { value: '24h',  label: t('settings.clockFormatTwentyFour') },
                      { value: '12h',  label: t('settings.clockFormatTwelve') },
                    ]}
                  />
                </div>
              </SettingsField>
            </SettingsSubCard>
          </SettingsGroup>
        </div>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.backupTitle')}
        icon={<HardDrive size={16} />}
      >
        <BackupSection />
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.loggingTitle')}
        icon={<Sliders size={16} />}
      >
        <div className="settings-card">
          <SettingsGroup>
            <SettingsSubCard>
              <SettingsField desc={t('settings.loggingModeDesc')}>
                <CustomSelect
                  value={auth.loggingMode}
                  onChange={(v) => auth.setLoggingMode(v as LoggingMode)}
                  options={[
                    { value: 'off', label: t('settings.loggingModeOff') },
                    { value: 'normal', label: t('settings.loggingModeNormal') },
                    { value: 'debug', label: t('settings.loggingModeDebug') },
                  ]}
                />
                {auth.loggingMode === 'debug' && (
                  <div>
                    <button className="btn btn-surface" onClick={exportRuntimeLogs}>
                      <Download size={14} />
                      {t('settings.loggingExport')}
                    </button>
                  </div>
                )}
              </SettingsField>
            </SettingsSubCard>
          </SettingsGroup>
        </div>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.aboutTitle')}
        icon={<Info size={16} />}
      >
        <div className="settings-card settings-about">
          <AboutPsysonicBrandHeader appVersion={appVersion} aboutVersionLabel={t('settings.aboutVersion')} />

          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, margin: '1rem 0 0.5rem' }}>
            {t('settings.aboutDesc')}
          </p>

          <div className="divider" style={{ margin: '1rem 0' }} />

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', fontSize: 13 }}>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <span style={{ color: 'var(--text-muted)', minWidth: 56 }}>{t('settings.aboutLicense')}</span>
              <span style={{ color: 'var(--text-secondary)' }}>{t('settings.aboutLicenseText')}</span>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <span style={{ color: 'var(--text-muted)', minWidth: 56 }}>Stack</span>
              <span style={{ color: 'var(--text-secondary)' }}>{t('settings.aboutBuiltWith')}</span>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <span style={{ color: 'var(--text-muted)', minWidth: 56, flexShrink: 0 }}>{t('settings.aboutMaintainersLabel')}</span>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                {MAINTAINERS.map(m => (
                  <div key={m.github} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <img
                      src={`https://github.com/${m.github}.png?size=32`}
                      width={20} height={20}
                      style={{ borderRadius: '50%', flexShrink: 0 }}
                      alt={m.github}
                    />
                    <button
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--accent)', fontWeight: 600, fontSize: 13 }}
                      onClick={() => openUrl(`https://github.com/${m.github}`)}
                    >
                      @{m.github}
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <span style={{ color: 'var(--text-muted)', minWidth: 56 }}>{t('settings.aboutReleaseNotesLabel')}</span>
              <button
                onClick={() => {
                  useAuthStore.getState().setLastSeenChangelogVersion('');
                  navigate('/whats-new');
                }}
                style={{ color: 'var(--accent)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
              >
                {t('settings.aboutReleaseNotesLink')}
              </button>
            </div>
          </div>

          <div className="settings-section-divider" style={{ marginTop: '1.25rem' }} />
          <SettingsToggle
            label={t('settings.showChangelogOnUpdate')}
            desc={t('settings.showChangelogOnUpdateDesc')}
            checked={auth.showChangelogOnUpdate}
            onChange={auth.setShowChangelogOnUpdate}
          />

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.25rem', flexWrap: 'wrap' }}>
            <button
              className="btn btn-ghost"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => openUrl('https://github.com/Psychotoxical/psysonic')}
            >
              <ExternalLink size={14} />
              {t('settings.aboutRepo')}
            </button>
          </div>
        </div>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.aboutContributorsLabel')}
        icon={<Users size={16} />}
      >
        <div className="contributors-subsection-label">{t('settings.aboutContributorsApp')}</div>
        <div className="contributors-grid">
          {CONTRIBUTORS.map(c =>
            renderContributorCard(
              c.github,
              <>
                <span className="contributor-card-since">v{c.since}</span>
                <span>·</span>
                <span>{t('settings.aboutContributorsCount', { count: c.contributions.length })}</span>
              </>,
              c.contributions,
            ),
          )}
        </div>

        {themeContributors.length > 0 && (
          <>
            <div className="contributors-subsection-label">{t('settings.aboutContributorsThemes')}</div>
            <div className="contributors-grid">
              {themeContributors.map(c =>
                renderContributorCard(
                  c.github,
                  <span>{t('settings.aboutThemeContributorsCount', { count: c.themes.length })}</span>,
                  c.themes,
                ),
              )}
            </div>
          </>
        )}
      </SettingsSubSection>

      <SettingsSubSection
        title={t('licenses.title')}
        icon={<Scale size={16} />}
      >
        <LicensesPanel />
      </SettingsSubSection>
    </>
  );
}
