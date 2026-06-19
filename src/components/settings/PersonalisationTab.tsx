import { useTranslation } from 'react-i18next';
import { Disc3, LayoutGrid, ListOrdered, ListTodo, PanelLeft, RotateCcw, Users } from 'lucide-react';
import { useArtistLayoutStore } from '../../store/artistLayoutStore';
import { useAuthStore } from '../../store/authStore';
import { useHomeStore } from '../../store/homeStore';
import { usePlayerBarLayoutStore } from '../../store/playerBarLayoutStore';
import { usePlaylistLayoutStore } from '../../store/playlistLayoutStore';
import { useQueueToolbarStore } from '../../store/queueToolbarStore';
import { useSidebarStore } from '../../store/sidebarStore';
import SettingsSubSection from '../SettingsSubSection';
import { SettingsGroup } from './SettingsGroup';
import { SettingsToggle } from './SettingsToggle';
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
  const preservePlayNextOrder = useAuthStore(s => s.preservePlayNextOrder);
  const setPreservePlayNextOrder = useAuthStore(s => s.setPreservePlayNextOrder);
  const advancedSettingsEnabled = useAuthStore(s => s.advancedSettingsEnabled);
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
        <SettingsGroup>
          <HomeCustomizer />
        </SettingsGroup>
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
        <SettingsGroup>
          <ArtistLayoutCustomizer />
        </SettingsGroup>
      </SettingsSubSection>

      {/* Queue Settings — display mode, queue behaviour and (advanced) the
          toolbar customizer, grouped under one category. */}
      <SettingsSubSection
        title={t('settings.queueSettingsTitle')}
        icon={<ListOrdered size={16} />}
      >
        <>
          <SettingsGroup title={t('settings.queueModeTitle')}>
            {/* Three mutually exclusive modes — exactly one is always active, so
                turning one on turns the others off; the active one cannot be
                switched off directly (ignore the uncheck). */}
            <SettingsToggle
              label={t('queue.title')}
              desc={t('settings.queueModeQueueSub')}
              checked={queueDisplayMode === 'queue'}
              onChange={c => { if (c) setQueueDisplayMode('queue'); }}
            />
            <div className="settings-section-divider" />
            <SettingsToggle
              label={t('queue.modePlaylist')}
              desc={t('settings.queueModePlaylistSub')}
              checked={queueDisplayMode === 'playlist'}
              onChange={c => { if (c) setQueueDisplayMode('playlist'); }}
            />
            <div className="settings-section-divider" />
            <SettingsToggle
              label={t('queue.modeTimeline')}
              desc={t('settings.queueModeTimelineSub')}
              checked={queueDisplayMode === 'timeline'}
              onChange={c => { if (c) setQueueDisplayMode('timeline'); }}
            />
          </SettingsGroup>

          <SettingsGroup title={t('settings.queueBehaviourTitle')}>
            <SettingsToggle
              label={t('settings.preservePlayNextOrder')}
              desc={t('settings.preservePlayNextOrderDesc')}
              checked={preservePlayNextOrder}
              onChange={setPreservePlayNextOrder}
            />
          </SettingsGroup>

          {advancedSettingsEnabled && (
            <SettingsGroup
              title={t('settings.queueToolbarTitle')}
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
            </SettingsGroup>
          )}
        </>
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
        <SettingsGroup>
          <PlaylistLayoutCustomizer />
        </SettingsGroup>
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
        <SettingsGroup>
          <PlayerBarLayoutCustomizer />
        </SettingsGroup>
      </SettingsSubSection>
    </>
  );
}
