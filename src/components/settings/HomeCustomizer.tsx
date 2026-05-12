import { useTranslation } from 'react-i18next';
import { useHomeStore, HomeSectionId } from '../../store/homeStore';

export function HomeCustomizer() {
  const { t } = useTranslation();
  const { sections, toggleSection } = useHomeStore();

  const SECTION_LABELS: Record<HomeSectionId, string> = {
    hero:            t('home.hero'),
    recent:          t('home.recent'),
    discover:        t('home.discover'),
    becauseYouLike:  t('home.becauseYouLike'),
    discoverSongs:   t('home.discoverSongs'),
    discoverArtists: t('home.discoverArtists'),
    recentlyPlayed:  t('home.recentlyPlayed'),
    starred:         t('home.starred'),
    mostPlayed:      t('home.mostPlayed'),
    losslessAlbums:  t('home.losslessAlbums'),
  };

  return (
    <div className="settings-card" style={{ padding: '4px 0' }}>
      {sections.map(sec => (
        <div key={sec.id} className="sidebar-customizer-row">
          <span style={{ flex: 1, fontSize: 14 }}>{SECTION_LABELS[sec.id]}</span>
          <label className="toggle-switch" aria-label={SECTION_LABELS[sec.id]}>
            <input type="checkbox" checked={sec.visible} onChange={() => toggleSection(sec.id)} />
            <span className="toggle-track" />
          </label>
        </div>
      ))}
    </div>
  );
}
