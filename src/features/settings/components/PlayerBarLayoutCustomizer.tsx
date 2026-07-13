import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Gauge, GripVertical, Heart, PictureInPicture2, SlidersVertical, Square, Star } from 'lucide-react';
import LastfmIcon from '@/ui/LastfmIcon';
import {
  usePlayerBarLayoutStore,
  PLAYER_BAR_LAYOUT_ZONES,
  type PlayerBarLayoutItemConfig,
  type PlayerBarLayoutItemId,
  type PlayerBarTrackInfoMode,
} from '@/features/playback/store/playerBarLayoutStore';
import { useListReorderDnd } from '@/lib/hooks/useListReorderDnd';
import { applyListReorderById, type ListReorderDropTarget } from '@/lib/util/listReorder';
import { ReorderGripHandle } from '@/features/settings/components/ReorderGripHandle';
import { SettingsSegmented } from '@/features/settings/components/SettingsSegmented';

const PLAYER_BAR_LAYOUT_LABEL_KEYS: Record<PlayerBarLayoutItemId, string> = {
  stop:       'settings.playerBarStop',
  starRating: 'settings.playerBarStarRating',
  favorite:   'settings.playerBarFavorite',
  lastfmLove: 'settings.playerBarLastfmLove',
  playbackRate: 'settings.playerBarPlaybackRate',
  equalizer:  'settings.playerBarEqualizer',
  miniPlayer: 'settings.playerBarMiniPlayer',
};

const PLAYER_BAR_LAYOUT_ICONS: Record<PlayerBarLayoutItemId, React.ReactNode> = {
  stop:       <Square size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />,
  starRating: <Star size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />,
  favorite:   <Heart size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />,
  lastfmLove: (
    <span style={{ color: 'var(--text-muted)', display: 'inline-flex', flexShrink: 0 }} aria-hidden>
      <LastfmIcon size={16} />
    </span>
  ),
  playbackRate: <Gauge size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />,
  equalizer:  <SlidersVertical size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />,
  miniPlayer: <PictureInPicture2 size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />,
};

const REORDER_TYPE = 'player_bar_layout_reorder';

export function PlayerBarLayoutCustomizer() {
  const { t } = useTranslation();
  const items = usePlayerBarLayoutStore(s => s.items);
  const setItems = usePlayerBarLayoutStore(s => s.setItems);
  const toggleItem = usePlayerBarLayoutStore(s => s.toggleItem);
  const trackInfoMode = usePlayerBarLayoutStore(s => s.trackInfoMode);
  const setTrackInfoMode = usePlayerBarLayoutStore(s => s.setTrackInfoMode);

  const itemsRef = useRef(items);
  // React Compiler refs rule: ref kept in sync with the latest value for use in handlers; not render data.
  // eslint-disable-next-line react-hooks/refs
  itemsRef.current = items;

  const transportItems = items.filter(i => PLAYER_BAR_LAYOUT_ZONES[i.id] === 'transport');
  const actionItems = items.filter(i => PLAYER_BAR_LAYOUT_ZONES[i.id] === 'actions');

  // Reorder resolves by stable id against the FULL list, so the zone filter that
  // decides which rows are shown can never share an index space with the move
  // (the #1164 class of bug).
  const apply = useCallback((draggedId: string, target: ListReorderDropTarget) => {
    const next = applyListReorderById(itemsRef.current, draggedId, target);
    if (next) setItems(next);
  }, [setItems]);

  const { isDragging, setContainer, onMouseMove, dropEdge } = useListReorderDnd({ type: REORDER_TYPE, apply });

  const row = (it: PlayerBarLayoutItemConfig, draggable: boolean) => {
    const label = t(PLAYER_BAR_LAYOUT_LABEL_KEYS[it.id]);
    const edge = draggable && isDragging ? dropEdge(it.id) : null;
    return (
      <div
        key={it.id}
        data-reorder-id={draggable ? it.id : undefined}
        className="sidebar-customizer-row"
        style={{
          borderTop:    edge === 'before' ? '2px solid var(--accent)' : undefined,
          borderBottom: edge === 'after'  ? '2px solid var(--accent)' : undefined,
        }}
      >
        {draggable ? (
          <ReorderGripHandle id={it.id} type={REORDER_TYPE} label={label} />
        ) : (
          // Transport items keep their fixed position, so they have no grip. The
          // spacer carries the same icon so it occupies the same width — an empty
          // span collapses and pulls the row out of line with the ones below.
          <span className="sidebar-customizer-grip" style={{ visibility: 'hidden' }} aria-hidden>
            <GripVertical size={16} />
          </span>
        )}
        {PLAYER_BAR_LAYOUT_ICONS[it.id]}
        <span style={{ flex: 1, fontSize: 14, opacity: it.visible ? 1 : 0.45 }}>{label}</span>
        <label className="toggle-switch" aria-label={label}>
          <input type="checkbox" checked={it.visible} onChange={() => toggleItem(it.id)} />
          <span className="toggle-track" />
        </label>
      </div>
    );
  };

  return (
    <div style={{ padding: '4px 0' }}>
      <div className="settings-group-title">{t('settings.playerBarTransportGroup')}</div>
      {transportItems.map(it => row(it, false))}

      <div className="settings-group-title" style={{ marginTop: '0.75rem' }}>
        {t('settings.playerBarActionsGroup')}
      </div>
      <div ref={setContainer} onMouseMove={onMouseMove}>
        {actionItems.map(it => row(it, true))}
      </div>

      <div className="settings-group-title" style={{ marginTop: '0.75rem' }}>
        {t('settings.playerBarTrackInfo')}
      </div>
      <SettingsSegmented<PlayerBarTrackInfoMode>
        options={[
          { id: 'title',      label: t('settings.playerBarTrackInfoTitle') },
          { id: 'titleAlbum', label: t('settings.playerBarTrackInfoTitleAlbum') },
        ]}
        value={trackInfoMode}
        onChange={setTrackInfoMode}
      />
    </div>
  );
}
