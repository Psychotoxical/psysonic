import { useTranslation } from 'react-i18next';
import { AudioLines, Music2 } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import SettingsSubSection from '../SettingsSubSection';
import { LyricsSourcesCustomizer } from './LyricsSourcesCustomizer';

export function LyricsTab() {
  const { t } = useTranslation();
  const sidebarLyricsStyle = useAuthStore(s => s.sidebarLyricsStyle);
  const setSidebarLyricsStyle = useAuthStore(s => s.setSidebarLyricsStyle);

  return (
    <>
      <SettingsSubSection
        title={t('settings.lyricsSourcesTitle')}
        icon={<Music2 size={16} />}
      >
        <LyricsSourcesCustomizer />
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.sidebarLyricsStyle')}
        icon={<AudioLines size={16} />}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {(['classic', 'apple'] as const).map(style => {
            const key = style === 'classic' ? 'Classic' : 'Apple';
            const other = style === 'classic' ? 'apple' : 'classic';
            return (
              <div key={style} className="settings-card">
                <div className="settings-toggle-row">
                  <div>
                    <div style={{ fontWeight: 500 }}>{t(`settings.sidebarLyricsStyle${key}` as any)}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t(`settings.sidebarLyricsStyle${key}Desc` as any)}</div>
                  </div>
                  <label className="toggle-switch" aria-label={t(`settings.sidebarLyricsStyle${key}` as any)}>
                    <input
                      type="checkbox"
                      checked={sidebarLyricsStyle === style}
                      onChange={e => setSidebarLyricsStyle(e.target.checked ? style : other)}
                    />
                    <span className="toggle-track" />
                  </label>
                </div>
              </div>
            );
          })}
        </div>
      </SettingsSubSection>
    </>
  );
}
