import React from 'react';
import { useTranslation } from 'react-i18next';
import { Heart, PictureInPicture2, SlidersVertical, Star } from 'lucide-react';
import LastfmIcon from '../LastfmIcon';
import { PlayerBarButtonId, usePlayerBarButtonsStore } from '../../store/playerBarButtonsStore';

const PLAYER_BAR_LABEL_KEYS: Record<PlayerBarButtonId, string> = {
  starRating: 'settings.playerBarStarRating',
  favorite: 'settings.playerBarFavorite',
  lastfmLove: 'settings.playerBarLastfmLove',
  equalizer: 'settings.playerBarEqualizer',
  miniPlayer: 'settings.playerBarMiniPlayer',
};

const PLAYER_BAR_ICONS: Record<PlayerBarButtonId, React.ReactNode> = {
  starRating: <Star size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />,
  favorite: <Heart size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />,
  lastfmLove: (
    <span style={{ color: 'var(--text-muted)', display: 'flex', flexShrink: 0 }} aria-hidden>
      <LastfmIcon size={16} />
    </span>
  ),
  equalizer: <SlidersVertical size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />,
  miniPlayer: <PictureInPicture2 size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />,
};

const ORDER: PlayerBarButtonId[] = ['starRating', 'favorite', 'lastfmLove', 'equalizer', 'miniPlayer'];

export function PlayerBarCustomizer() {
  const { t } = useTranslation();
  const visibility = usePlayerBarButtonsStore(s => s.visibility);
  const toggle = usePlayerBarButtonsStore(s => s.toggle);

  return (
    <div className="settings-card" style={{ padding: '4px 0' }}>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 12px 10px', lineHeight: 1.45 }}>
        {t('settings.playerBarDesc')}
      </p>
      {ORDER.map((id) => {
        const label = t(PLAYER_BAR_LABEL_KEYS[id]);
        const on = visibility[id];
        return (
          <div key={id} className="sidebar-customizer-row">
            {PLAYER_BAR_ICONS[id]}
            <span style={{ flex: 1, fontSize: 14, opacity: on ? 1 : 0.45 }}>{label}</span>
            <label className="toggle-switch" aria-label={label}>
              <input type="checkbox" checked={on} onChange={() => toggle(id)} />
              <span className="toggle-track" />
            </label>
          </div>
        );
      })}
    </div>
  );
}
