import { useTranslation } from 'react-i18next';
import { Disc3, LayoutGrid, ListOrdered, ListTodo, PanelLeft, RotateCcw, Users } from 'lucide-react';
import { useArtistLayoutStore } from '@/features/artist';
import { useAuthStore } from '@/store/authStore';
import type { QueueDisplayMode } from '@/store/authStoreTypes';
import { useHomeStore } from '@/features/home';
import { usePlayerBarLayoutStore } from '@/features/playback/store/playerBarLayoutStore';
import { usePlaylistLayoutStore } from '@/features/playlist';
import { useQueueToolbarStore } from '@/store/queueToolbarStore';
import { useSidebarStore } from '@/features/sidebar';
import SettingsSubSection from '@/features/settings/components/SettingsSubSection';
import { SettingsGroup } from '@/features/settings/components/SettingsGroup';
import { SettingsToggle } from '@/features/settings/components/SettingsToggle';
import { SettingsSegmented, type SegmentedOption } from '@/features/settings/components/SettingsSegmented';
import { SettingsSubCard, SettingsField } from '@/features/settings/components/SettingsSubCard';
import { ArtistLayoutCustomizer } from '@/features/settings/components/ArtistLayoutCustomizer';
import { HomeCustomizer } from '@/features/settings/components/HomeCustomizer';
import { PlayerBarLayoutCustomizer } from '@/features/settings/components/PlayerBarLayoutCustomizer';
import { PlaylistLayoutCustomizer } from '@/features/settings/components/PlaylistLayoutCustomizer';
import { QueueToolbarCustomizer } from '@/features/settings/components/QueueToolbarCustomizer';
import { SidebarCustomizer } from '@/features/settings/components/SidebarCustomizer';

export function PersonalisationTab() {
  const { t } = useTranslation();
  const queueDisplayMode = useAuthStore(s => s.queueDisplayMode);
  const setQueueDisplayMode = useAuthStore(s => s.setQueueDisplayMode);
  const preservePlayNextOrder = useAuthStore(s => s.preservePlayNextOrder);
  const setPreservePlayNextOrder = useAuthStore(s => s.setPreservePlayNextOrder);
  const advancedSettingsEnabled = useAuthStore(s => s.advancedSettingsEnabled);

  const queueModeOptions: SegmentedOption<QueueDisplayMode>[] = [
    { id: 'queue', label: t('queue.title') },
    { id: 'playlist', label: t('queue.modePlaylist') },
    { id: 'timeline', label: t('queue.modeTimeline') },
  ];
  const queueModeDescKey =
    queueDisplayMode === 'queue'
      ? 'settings.queueModeQueueSub'
      : queueDisplayMode === 'playlist'
        ? 'settings.queueModePlaylistSub'
        : 'settings.queueModeTimelineSub';

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
          {/* Three mutually exclusive modes — a segmented picker enforces that
              exactly one is active, instead of toggles that read as independent. */}
          <SettingsGroup title={t('settings.queueModeTitle')}>
            <SettingsSegmented
              options={queueModeOptions}
              value={queueDisplayMode}
              onChange={setQueueDisplayMode}
            />
            <SettingsSubCard style={{ marginTop: '0.85rem' }}>
              <SettingsField desc={t(queueModeDescKey)} />
            </SettingsSubCard>
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
