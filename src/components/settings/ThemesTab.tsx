import { useTranslation } from 'react-i18next';
import { Clock, Palette } from 'lucide-react';
import { useThemeStore } from '../../store/themeStore';
import CustomSelect from '../CustomSelect';
import SettingsSubSection from '../SettingsSubSection';
import ThemePicker, { THEME_GROUPS } from '../ThemePicker';

/**
 * Dedicated Themes tab: theme selection, the day/night scheduler, and (added in
 * a later step) the community Theme Store. Theme selection + scheduler were
 * moved here out of the Appearance tab so all theme concerns live in one place.
 */
export function ThemesTab() {
  const { t, i18n } = useTranslation();
  const theme = useThemeStore();

  return (
    <>
      <SettingsSubSection
        title={t('settings.theme')}
        icon={<Palette size={16} />}
      >
        <div className="settings-card">
          {theme.enableThemeScheduler && (
            <div className="settings-hint settings-hint-info" style={{ marginBottom: '0.75rem' }}>
              {t('settings.themeSchedulerActiveHint')}
            </div>
          )}
          <ThemePicker value={theme.theme} onChange={v => theme.setTheme(v as any)} />
        </div>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.themeSchedulerTitle')}
        icon={<Clock size={16} />}
      >
        <div className="settings-card">
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
            const themeOptions = THEME_GROUPS.flatMap(g =>
              g.themes.map(th => ({
                value: th.id,
                label: th.family ? `${th.family} ${th.label}` : th.label,
                group: g.group,
              }))
            );
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
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', marginTop: '1rem' }}>
                <div className="form-group">
                  <label className="settings-label" style={{ marginBottom: 6 }}>{t('settings.themeSchedulerDayTheme')}</label>
                  <CustomSelect value={theme.themeDay} onChange={theme.setThemeDay} options={themeOptions} />
                </div>
                <div className="form-group">
                  <label className="settings-label" style={{ marginBottom: 6 }}>{t('settings.themeSchedulerDayStart')}</label>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <CustomSelect value={dayH} onChange={v => theme.setTimeDayStart(`${v}:${dayM}`)} options={hourOptions} />
                    <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>:</span>
                    <CustomSelect value={dayM} onChange={v => theme.setTimeDayStart(`${dayH}:${v}`)} options={minuteOptions} />
                  </div>
                </div>
                <div className="form-group">
                  <label className="settings-label" style={{ marginBottom: 6 }}>{t('settings.themeSchedulerNightTheme')}</label>
                  <CustomSelect value={theme.themeNight} onChange={theme.setThemeNight} options={themeOptions} />
                </div>
                <div className="form-group">
                  <label className="settings-label" style={{ marginBottom: 6 }}>{t('settings.themeSchedulerNightStart')}</label>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <CustomSelect value={nightH} onChange={v => theme.setTimeNightStart(`${v}:${nightM}`)} options={hourOptions} />
                    <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>:</span>
                    <CustomSelect value={nightM} onChange={v => theme.setTimeNightStart(`${nightH}:${v}`)} options={minuteOptions} />
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      </SettingsSubSection>
    </>
  );
}
