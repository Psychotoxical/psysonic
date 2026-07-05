import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Shuffle, Dices, Sparkles } from 'lucide-react';
import { useLuckyMixAvailable } from '@/features/randomMix/hooks/useLuckyMixAvailable';

interface MixCard {
  icon: React.ElementType;
  labelKey: string;
  descKey: string;
  to: string;
}

const CARDS: MixCard[] = [
  {
    icon: Shuffle,
    labelKey: 'randomLanding.mixByTracks',
    descKey:  'randomLanding.mixByTracksDesc',
    to: '/random/mix',
  },
  {
    icon: Dices,
    labelKey: 'randomLanding.mixByAlbums',
    descKey:  'randomLanding.mixByAlbumsDesc',
    to: '/random/albums',
  },
];

export default function RandomLanding() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // RandomLanding is only reachable in "hub" nav mode, so we don't need to
  // gate on randomNavMode here — availability alone is enough.
  const luckyMixAvailable = useLuckyMixAvailable();
  const cards = luckyMixAvailable
    ? [
        ...CARDS,
        {
          icon: Sparkles,
          labelKey: 'randomLanding.mixByLucky',
          descKey: 'randomLanding.mixByLuckyDesc',
          to: '/lucky-mix',
        },
      ]
    : CARDS;

  return (
    <div className="random-landing">
      <div className="random-landing-grid">
        {cards.map(({ icon: Icon, labelKey, descKey, to }) => (
          <button
            key={to}
            className="mix-pick-card"
            onClick={() => navigate(to)}
          >
            <Icon className="mix-pick-card-bg-icon" strokeWidth={1} aria-hidden />
            <div className="mix-pick-card-content">
              <Icon size={28} strokeWidth={1.5} className="mix-pick-card-icon" aria-hidden />
              <span className="mix-pick-card-label">{t(labelKey)}</span>
              <span className="mix-pick-card-desc">{t(descKey)}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
