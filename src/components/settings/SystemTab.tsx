import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { open as openUrl } from '@tauri-apps/plugin-shell';
import { AppWindow, ChevronDown, Download, ExternalLink, Globe, HardDrive, Info, Scale, Sliders, Users } from 'lucide-react';
import { version as appVersion } from '../../../package.json';
import i18n from '../../i18n';
import { useAuthStore } from '../../store/authStore';
import type { LoggingMode } from '../../store/authStoreTypes';
import { IS_LINUX } from '../../utils/platform';
import { showToast } from '../../utils/toast';
import { AboutPsysonicBrandHeader } from '../AboutPsysonicLol';
import CustomSelect from '../CustomSelect';
import LicensesPanel from '../LicensesPanel';
import SettingsSubSection from '../SettingsSubSection';
import { BackupSection } from './BackupSection';
import { CONTRIBUTORS, MAINTAINERS } from '../../config/settingsCredits';

export function SystemTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const auth = useAuthStore();

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
              ]}
            />
          </div>
        </div>
      </SettingsSubSection>

      {/* App-Verhalten (aus altem library/general Behavior-Block) */}
      <SettingsSubSection
        title={t('settings.behavior')}
        icon={<AppWindow size={16} />}
      >
        <div className="settings-card">
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.showTrayIcon')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.showTrayIconDesc')}</div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.showTrayIcon')}>
              <input type="checkbox" checked={auth.showTrayIcon} onChange={e => auth.setShowTrayIcon(e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </div>
          <div className="settings-section-divider" />
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.minimizeToTray')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.minimizeToTrayDesc')}</div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.minimizeToTray')}>
              <input type="checkbox" checked={auth.minimizeToTray} onChange={e => auth.setMinimizeToTray(e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </div>
          {IS_LINUX && (
            <>
              <div className="settings-section-divider" />
              <div className="settings-toggle-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{t('settings.linuxWebkitSmoothScroll')}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.linuxWebkitSmoothScrollDesc')}</div>
                </div>
                <label className="toggle-switch" aria-label={t('settings.linuxWebkitSmoothScroll')}>
                  <input
                    type="checkbox"
                    checked={auth.linuxWebkitKineticScroll}
                    onChange={e => auth.setLinuxWebkitKineticScroll(e.target.checked)}
                  />
                  <span className="toggle-track" />
                </label>
              </div>
            </>
          )}
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
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.showChangelogOnUpdate')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.showChangelogOnUpdateDesc')}</div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.showChangelogOnUpdate')}>
              <input
                type="checkbox"
                checked={auth.showChangelogOnUpdate}
                onChange={e => auth.setShowChangelogOnUpdate(e.target.checked)}
              />
              <span className="toggle-track" />
            </label>
          </div>

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
          {[...CONTRIBUTORS].sort((a, b) => b.contributions.length - a.contributions.length).map(c => (
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
