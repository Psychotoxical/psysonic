import { useTranslation } from 'react-i18next';
import { LayoutGrid, ListMusic, ListTodo, PanelLeft, RotateCcw, Users } from 'lucide-react';
import { useArtistLayoutStore } from '../../store/artistLayoutStore';
import { useHomeStore } from '../../store/homeStore';
import { usePlaylistLayoutStore } from '../../store/playlistLayoutStore';
import { useQueueToolbarStore } from '../../store/queueToolbarStore';
import { useSidebarStore } from '../../store/sidebarStore';
import SettingsSubSection from '../SettingsSubSection';
import { ArtistLayoutCustomizer } from './ArtistLayoutCustomizer';
import { HomeCustomizer } from './HomeCustomizer';
import { PlaylistLayoutCustomizer } from './PlaylistLayoutCustomizer';
import { QueueToolbarCustomizer } from './QueueToolbarCustomizer';
import { SidebarCustomizer } from './SidebarCustomizer';

export function PersonalisationTab() {
  const { t } = useTranslation();
  return (
    <>
      <SettingsSubSection
        title={t('settings.sidebarTitle')}
        icon={<PanelLeft size={16} />}
        action={
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12, color: 'var(--text-muted)', padding: '2px 6px' }}
            onClick={() => useSidebarStore.getState().reset()}
            data-tooltip={t('settings.sidebarReset')}
            aria-label={t('settings.sidebarReset')}
          >
            <RotateCcw size={14} />
          </button>
        }
      >
        <SidebarCustomizer />
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.homeCustomizerTitle')}
        icon={<LayoutGrid size={16} />}
        action={
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12, color: 'var(--text-muted)', padding: '2px 6px' }}
            onClick={() => useHomeStore.getState().reset()}
            data-tooltip={t('settings.sidebarReset')}
            aria-label={t('settings.sidebarReset')}
          >
            <RotateCcw size={14} />
          </button>
        }
      >
        <HomeCustomizer />
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.artistLayoutTitle')}
        icon={<Users size={16} />}
        advanced
        action={
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12, color: 'var(--text-muted)', padding: '2px 6px' }}
            onClick={() => useArtistLayoutStore.getState().reset()}
            data-tooltip={t('settings.artistLayoutReset')}
            aria-label={t('settings.artistLayoutReset')}
          >
            <RotateCcw size={14} />
          </button>
        }
      >
        <ArtistLayoutCustomizer />
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.queueToolbarTitle')}
        icon={<ListMusic size={16} />}
        advanced
        action={
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12, color: 'var(--text-muted)', padding: '2px 6px' }}
            onClick={() => useQueueToolbarStore.getState().reset()}
            data-tooltip={t('settings.queueToolbarReset')}
            aria-label={t('settings.queueToolbarReset')}
          >
            <RotateCcw size={14} />
          </button>
        }
      >
        <QueueToolbarCustomizer />
      </SettingsSubSection>

      <SettingsSubSection
        title={t('settings.playlistLayoutTitle')}
        icon={<ListTodo size={16} />}
        advanced
        action={
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12, color: 'var(--text-muted)', padding: '2px 6px' }}
            onClick={() => usePlaylistLayoutStore.getState().reset()}
            data-tooltip={t('settings.playlistLayoutReset')}
            aria-label={t('settings.playlistLayoutReset')}
          >
            <RotateCcw size={14} />
          </button>
        }
      >
        <PlaylistLayoutCustomizer />
      </SettingsSubSection>
    </>
  );
}
