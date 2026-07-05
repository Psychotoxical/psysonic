import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, Palette, Store, Upload } from 'lucide-react';
import { useThemeStore } from '@/store/themeStore';
import { useInstalledThemesStore } from '@/store/installedThemesStore';
import CustomSelect from '@/ui/CustomSelect';
import BackToTopButton from '@/ui/BackToTopButton';
import { FIXED_THEMES } from '@/lib/themes/fixedThemes';
import { InstalledThemes } from '@/features/settings/components/InstalledThemes';
import { ThemeImportSection } from '@/features/settings/components/ThemeImportSection';
import { ThemeStoreSection } from '@/features/settings/components/ThemeStoreSection';
import { SettingsGroup } from '@/features/settings/components/SettingsGroup';
import { SettingsSubCard, SettingsField } from '@/features/settings/components/SettingsSubCard';

/**
 * A flat, always-visible section. The Themes tab has a single purpose, so its
 * parts are laid out one below the other with no collapsing — deliberately not
 * the collapsible <details> SettingsSubSection used elsewhere. `data-settings-
 * search` keeps each section reachable from the global settings search.
 */
function ThemesSection({ icon, title, children, boxed }: { icon: ReactNode; title: string; children: ReactNode; boxed?: boolean }) {
  if (boxed) {
    return (
      <section className="themes-section" data-settings-search={title} style={{ marginBottom: '1.75rem' }}>
        <div className="settings-card">
          <SettingsGroup title={title} icon={icon}>{children}</SettingsGroup>
        </div>
      </section>
    );
  }
  return (
    <section className="themes-section" data-settings-search={title} style={{ marginBottom: '1.75rem' }}>
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600, margin: '0 0 0.75rem' }}>
        <span style={{ display: 'inline-flex', color: 'var(--accent)' }}>{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Dedicated Themes tab: pick a theme (fixed cores + installed community themes),
 * the day/night scheduler, and the community Theme Store — all flat on one page.
 */
export function ThemesTab() {
  const { t, i18n } = useTranslation();
  const theme = useThemeStore();
  const installed = useInstalledThemesStore(s => s.themes);

  return (
    <>
      <ThemesSection icon={<Palette size={16} />} title={t('settings.themesYourThemesTitle')} boxed>
        {theme.enableThemeScheduler && (
          <div className="settings-hint settings-hint-info" style={{ marginBottom: '0.75rem' }}>
            {t('settings.themeSchedulerActiveHint')}
          </div>
        )}
        <InstalledThemes />
      </ThemesSection>

      <ThemesSection icon={<Clock size={16} />} title={t('settings.themeSchedulerTitle')} boxed>
        <div>
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('settings.themeSchedulerEnable')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.themeSchedulerEnableSub')}</div>
            </div>
            <label className="toggle-switch" aria-label={t('settings.themeSchedulerEnable')}>
              <input type="checkbox" checked={theme.enableThemeScheduler} onChange={e => theme.setEnableThemeScheduler(e.target.checked)} />
              <span className="toggle-track" />
            </label>
          </div>
          {theme.enableThemeScheduler && (() => {
            const themeOptions = [
              ...FIXED_THEMES.map(f => ({ value: f.id, label: f.label })),
              ...installed.map(it => ({
                value: it.id,
                label: it.name,
                group: t('settings.themesYourThemesTitle'),
              })),
            ];
            const use12h = i18n.language === 'en';
            const hourOptions = Array.from({ length: 24 }, (_, i) => {
              const value = String(i).padStart(2, '0');
              const label = use12h
                ? `${i % 12 === 0 ? 12 : i % 12} ${i < 12 ? 'AM' : 'PM'}`
                : value;
              return { value, label };
            });
            const minuteOptions = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'].map(m => ({ value: m, label: m }));
            const dayH = theme.timeDayStart.split(':')[0];
            const dayM = theme.timeDayStart.split(':')[1];
            const nightH = theme.timeNightStart.split(':')[0];
            const nightM = theme.timeNightStart.split(':')[1];
            const isSystem = theme.schedulerMode === 'system';
            return (
              <SettingsSubCard style={{ marginTop: '0.85rem' }}>
                <SettingsField label={t('settings.themeSchedulerModeLabel')}>
                  <div className="settings-segmented">
                    <button
                      type="button"
                      className={`btn ${!isSystem ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => theme.setSchedulerMode('time')}
                    >
                      {t('settings.themeSchedulerModeTime')}
                    </button>
                    <button
                      type="button"
                      className={`btn ${isSystem ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => theme.setSchedulerMode('system')}
                    >
                      {t('settings.themeSchedulerModeSystem')}
                    </button>
                  </div>
                </SettingsField>
                {isSystem && (
                  <div className="settings-hint settings-hint-info">
                    {t('settings.themeSchedulerSystemRestartHint')}
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem' }}>
                  <div className="form-group">
                    <label className="settings-label" style={{ marginBottom: 6 }}>
                      {isSystem ? t('settings.themeSchedulerLightTheme') : t('settings.themeSchedulerDayTheme')}
                    </label>
                    <CustomSelect value={theme.themeDay} onChange={theme.setThemeDay} options={themeOptions} />
                  </div>
                  {!isSystem && (
                    <div className="form-group">
                      <label className="settings-label" style={{ marginBottom: 6 }}>{t('settings.themeSchedulerDayStart')}</label>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <CustomSelect value={dayH} onChange={v => theme.setTimeDayStart(`${v}:${dayM}`)} options={hourOptions} />
                        <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>:</span>
                        <CustomSelect value={dayM} onChange={v => theme.setTimeDayStart(`${dayH}:${v}`)} options={minuteOptions} />
                      </div>
                    </div>
                  )}
                  <div className="form-group">
                    <label className="settings-label" style={{ marginBottom: 6 }}>
                      {isSystem ? t('settings.themeSchedulerDarkTheme') : t('settings.themeSchedulerNightTheme')}
                    </label>
                    <CustomSelect value={theme.themeNight} onChange={theme.setThemeNight} options={themeOptions} />
                  </div>
                  {!isSystem && (
                    <div className="form-group">
                      <label className="settings-label" style={{ marginBottom: 6 }}>{t('settings.themeSchedulerNightStart')}</label>
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <CustomSelect value={nightH} onChange={v => theme.setTimeNightStart(`${v}:${nightM}`)} options={hourOptions} />
                        <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>:</span>
                        <CustomSelect value={nightM} onChange={v => theme.setTimeNightStart(`${nightH}:${v}`)} options={minuteOptions} />
                      </div>
                    </div>
                  )}
                </div>
              </SettingsSubCard>
            );
          })()}
        </div>
      </ThemesSection>

      <ThemesSection icon={<Upload size={16} />} title={t('settings.themeImportTitle')} boxed>
        <ThemeImportSection />
      </ThemesSection>

      <ThemesSection icon={<Store size={16} />} title={t('settings.themeStoreTitle')}>
        <ThemeStoreSection />
      </ThemesSection>

      <BackToTopButton />
    </>
  );
}
