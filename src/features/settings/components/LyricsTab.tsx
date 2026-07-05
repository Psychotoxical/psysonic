import { useTranslation } from 'react-i18next';
import { AudioLines, Music2 } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import SettingsSubSection from '@/features/settings/components/SettingsSubSection';
import { SettingsGroup } from '@/features/settings/components/SettingsGroup';
import { LyricsSourcesCustomizer } from '@/features/settings/components/LyricsSourcesCustomizer';
import { SettingsSegmented, type SegmentedOption } from '@/features/settings/components/SettingsSegmented';
import { SettingsSubCard, SettingsField } from '@/features/settings/components/SettingsSubCard';

export function LyricsTab() {
  const { t } = useTranslation();
  const sidebarLyricsStyle = useAuthStore(s => s.sidebarLyricsStyle);
  const setSidebarLyricsStyle = useAuthStore(s => s.setSidebarLyricsStyle);

  const lyricsStyleOptions: SegmentedOption<'classic' | 'apple'>[] = [
    { id: 'classic', label: t('settings.sidebarLyricsStyleClassic') },
    { id: 'apple', label: t('settings.sidebarLyricsStyleApple') },
  ];
  const lyricsStyleDescKey =
    sidebarLyricsStyle === 'classic'
      ? 'settings.sidebarLyricsStyleClassicDesc'
      : 'settings.sidebarLyricsStyleAppleDesc';

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
          <SettingsSegmented
            options={lyricsStyleOptions}
            value={sidebarLyricsStyle}
            onChange={setSidebarLyricsStyle}
          />
          <SettingsSubCard style={{ marginTop: '0.85rem' }}>
            <SettingsField desc={t(lyricsStyleDescKey)} />
          </SettingsSubCard>
        </SettingsGroup>
      </SettingsSubSection>
    </>
  );
}
