import { useTranslation } from 'react-i18next';
import { AudioLines, Music2 } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import SettingsSubSection from '../SettingsSubSection';
import { SettingsGroup } from './SettingsGroup';
import { SettingsToggle } from './SettingsToggle';
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
        <SettingsGroup>
          <LyricsSourcesCustomizer />
        </SettingsGroup>
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.sidebarLyricsStyle')}
        icon={<AudioLines size={16} />}
      >
        <SettingsGroup>
          {(['classic', 'apple'] as const).map((style, i) => {
            const key = style === 'classic' ? 'Classic' : 'Apple';
            const other = style === 'classic' ? 'apple' : 'classic';
            return (
              <div key={style}>
                {i > 0 && <div className="settings-section-divider" />}
                <SettingsToggle
                  label={t(`settings.sidebarLyricsStyle${key}`)}
                  desc={t(`settings.sidebarLyricsStyle${key}Desc`)}
                  checked={sidebarLyricsStyle === style}
                  onChange={c => setSidebarLyricsStyle(c ? style : other)}
                />
              </div>
            );
          })}
        </SettingsGroup>
      </SettingsSubSection>
    </>
  );
}
