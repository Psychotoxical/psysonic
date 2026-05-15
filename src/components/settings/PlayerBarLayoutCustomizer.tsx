import React from 'react';
import { useTranslation } from 'react-i18next';
import { Heart, PictureInPicture2, SlidersVertical, Star } from 'lucide-react';
import LastfmIcon from '../LastfmIcon';
import {
  usePlayerBarLayoutStore,
  type PlayerBarLayoutItemId,
} from '../../store/playerBarLayoutStore';

const PLAYER_BAR_LAYOUT_LABEL_KEYS: Record<PlayerBarLayoutItemId, string> = {
  starRating: 'settings.playerBarStarRating',
  favorite:   'settings.playerBarFavorite',
  lastfmLove: 'settings.playerBarLastfmLove',
  equalizer:  'settings.playerBarEqualizer',
  miniPlayer: 'settings.playerBarMiniPlayer',
};

const PLAYER_BAR_LAYOUT_ICONS: Record<PlayerBarLayoutItemId, React.ReactNode> = {
  starRating: <Star size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />,
  favorite:   <Heart size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />,
  lastfmLove: (
    <span style={{ color: 'var(--text-muted)', display: 'inline-flex', flexShrink: 0 }} aria-hidden>
      <LastfmIcon size={16} />
    </span>
  ),
  equalizer:  <SlidersVertical size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />,
  miniPlayer: <PictureInPicture2 size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />,
};

export function PlayerBarLayoutCustomizer() {
  const { t } = useTranslation();
  const items = usePlayerBarLayoutStore(s => s.items);
  const toggleItem = usePlayerBarLayoutStore(s => s.toggleItem);

  return (
    <div className="settings-card" style={{ padding: '4px 0' }}>
      {items.map((it) => {
        const label = t(PLAYER_BAR_LAYOUT_LABEL_KEYS[it.id]);
        return (
          <div key={it.id} className="sidebar-customizer-row">
            {PLAYER_BAR_LAYOUT_ICONS[it.id]}
            <span style={{ flex: 1, fontSize: 14, opacity: it.visible ? 1 : 0.45 }}>{label}</span>
            <label className="toggle-switch" aria-label={label}>
              <input type="checkbox" checked={it.visible} onChange={() => toggleItem(it.id)} />
              <span className="toggle-track" />
            </label>
          </div>
        );
      })}
    </div>
  );
}
