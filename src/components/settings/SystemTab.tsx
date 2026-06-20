import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { AppWindow, ChevronDown, Download, ExternalLink, Globe, HardDrive, Info, Scale, Sliders, Users } from 'lucide-react';
import { version as appVersion } from '../../../package.json';
import i18n from '../../i18n';
import { useAuthStore } from '../../store/authStore';
import type { ClockFormat, LinuxWaylandTextRenderProfile, LoggingMode } from '../../store/authStoreTypes';
import { IS_LINUX } from '../../utils/platform';
import { showToast } from '../../utils/ui/toast';
import { AboutPsysonicBrandHeader } from '../AboutPsysonicLol';
import CustomSelect from '../CustomSelect';
import LicensesPanel from '../LicensesPanel';
import SettingsSubSection from '../SettingsSubSection';
import { SettingsGroup } from './SettingsGroup';
import { SettingsToggle } from './SettingsToggle';
import { BackupSection } from './BackupSection';
import { CONTRIBUTORS, MAINTAINERS } from '../../config/settingsCredits';

export function SystemTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const auth = useAuthStore();
  const [waylandTextRenderAvailable, setWaylandTextRenderAvailable] = useState(false);

  useEffect(() => {
    if (!IS_LINUX) return;
    invoke<boolean>('linux_wayland_text_render_settings_available')
      .then(setWaylandTextRenderAvailable)
      .catch(() => {});
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
      const lines = await invoke<number>('export_runtime_logs', { path: selected });
      showToast(t('settings.loggingExportSuccess', { count: lines }), 3500, 'info');
    } catch (e) {
      console.error(e);
      showToast(t('settings.loggingExportError'), 4500, 'error');
    }
  };

  return (
    <>
      <SettingsSubSection
        title={t('settings.language')}
        icon={<Globe size={16} />}
      >
        <div className="settings-card">
          <SettingsGroup>
            <div className="form-group" style={{ maxWidth: '300px' }}>
              <CustomSelect
                value={i18n.language}
                onChange={v => i18n.changeLanguage(v)}
                options={[
                  { value: 'en', label: t('settings.languageEn') },
                  { value: 'de', label: t('settings.languageDe') },
                  { value: 'es', label: t('settings.languageEs') },
                  { value: 'fr', label: t('settings.languageFr') },
                  { value: 'nl', label: t('settings.languageNl') },
                  { value: 'nb', label: t('settings.languageNb') },
                  { value: 'ru', label: t('settings.languageRu') },
                  { value: 'zh', label: t('settings.languageZh') },
                  { value: 'ro', label: t('settings.languageRo') },
                  { value: 'ja', label: t('settings.languageJa') },
                ]}
              />
            </div>
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
                <>
                  <div className="settings-section-divider" />
                  <div className="form-group" style={{ maxWidth: '420px' }}>
                    <div style={{ fontWeight: 500 }}>{t('settings.linuxWaylandTextRender')}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                      {t('settings.linuxWaylandTextRenderDesc')}
                    </div>
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
                  </div>
                </>
              )}
            </SettingsGroup>
          )}

          <SettingsGroup title={t('settings.groupClock')}>
            <div className="settings-toggle-row">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 500 }}>{t('settings.clockFormat')}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.clockFormatDesc')}</div>
              </div>
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
            </div>
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
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
              {t('settings.loggingModeDesc')}
            </div>
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
              <div style={{ marginTop: '0.75rem' }}>
                <button className="btn btn-surface" onClick={exportRuntimeLogs}>
                  <Download size={14} />
                  {t('settings.loggingExport')}
                </button>
              </div>
            )}
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
        <div className="contributors-grid">
          {CONTRIBUTORS.map(c => (
            <details key={c.github} className="contributor-card">
              <summary className="contributor-card-summary">
                <img
                  src={`https://github.com/${c.github}.png?size=48`}
                  width={32}
                  height={32}
                  className="contributor-card-avatar"
                  alt={c.github}
                />
                <div className="contributor-card-meta">
                  <span
                    className="contributor-card-name"
                    role="button"
                    tabIndex={0}
                    onClick={e => { e.stopPropagation(); openUrl(`https://github.com/${c.github}`); }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                        e.preventDefault();
                        openUrl(`https://github.com/${c.github}`);
                      }
                    }}
                  >
                    @{c.github}
                  </span>
                  <span className="contributor-card-sub">
                    <span className="contributor-card-since">v{c.since}</span>
                    <span>·</span>
                    <span>{t('settings.aboutContributorsCount', { count: c.contributions.length })}</span>
                  </span>
                </div>
                <ChevronDown size={14} className="contributor-card-chevron" aria-hidden />
              </summary>
              <ul className="contributor-card-list">
                {c.contributions.map(item => <li key={item}>{item}</li>)}
              </ul>
            </details>
          ))}
        </div>
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
