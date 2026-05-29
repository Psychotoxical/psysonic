import { useTranslation } from 'react-i18next';
import { Disc3, LayoutGrid, ListMusic, ListOrdered, ListTodo, PanelLeft, RotateCcw, Users } from 'lucide-react';
import { useArtistLayoutStore } from '../../store/artistLayoutStore';
import { useAuthStore } from '../../store/authStore';
import { useHomeStore } from '../../store/homeStore';
import { usePlayerBarLayoutStore } from '../../store/playerBarLayoutStore';
import { usePlaylistLayoutStore } from '../../store/playlistLayoutStore';
import { useQueueToolbarStore } from '../../store/queueToolbarStore';
import { useSidebarStore } from '../../store/sidebarStore';
import SettingsSubSection from '../SettingsSubSection';
import { ArtistLayoutCustomizer } from './ArtistLayoutCustomizer';
import { HomeCustomizer } from './HomeCustomizer';
import { PlayerBarLayoutCustomizer } from './PlayerBarLayoutCustomizer';
import { PlaylistLayoutCustomizer } from './PlaylistLayoutCustomizer';
import { QueueToolbarCustomizer } from './QueueToolbarCustomizer';
import { SidebarCustomizer } from './SidebarCustomizer';

export function PersonalisationTab() {
  const { t } = useTranslation();
  const queueDisplayMode = useAuthStore(s => s.queueDisplayMode);
  const setQueueDisplayMode = useAuthStore(s => s.setQueueDisplayMode);
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
        title={t('settings.queueModeTitle')}
        icon={<ListOrdered size={16} />}
      >
        <div className="settings-card">
          {/* Two mutually exclusive modes — exactly one is always active, so
              turning one on turns the other off; the active one cannot be
              switched off directly (ignore the uncheck). */}
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('queue.title')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.queueModeQueueSub')}</div>
            </div>
            <label className="toggle-switch" aria-label={t('queue.title')}>
              <input
                type="checkbox"
                checked={queueDisplayMode === 'queue'}
                onChange={e => { if (e.target.checked) setQueueDisplayMode('queue'); }}
              />
              <span className="toggle-track" />
            </label>
          </div>
          <div className="settings-section-divider" />
          <div className="settings-toggle-row">
            <div>
              <div style={{ fontWeight: 500 }}>{t('queue.modePlaylist')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('settings.queueModePlaylistSub')}</div>
            </div>
            <label className="toggle-switch" aria-label={t('queue.modePlaylist')}>
              <input
                type="checkbox"
                checked={queueDisplayMode === 'playlist'}
                onChange={e => { if (e.target.checked) setQueueDisplayMode('playlist'); }}
              />
              <span className="toggle-track" />
            </label>
          </div>
        </div>
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

      <SettingsSubSection
        title={t('settings.playerBarTitle')}
        icon={<Disc3 size={16} />}
        advanced
        action={
          <button
            type="button"
            className="btn btn-ghost"
            style={{ fontSize: 12, color: 'var(--text-muted)', padding: '2px 6px' }}
            onClick={() => usePlayerBarLayoutStore.getState().reset()}
            data-tooltip={t('settings.playerBarReset')}
            aria-label={t('settings.playerBarReset')}
          >
            <RotateCcw size={14} />
          </button>
        }
      >
        <PlayerBarLayoutCustomizer />
      </SettingsSubSection>
    </>
  );
}
