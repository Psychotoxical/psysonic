import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Disc3, Search, Music4, AudioLines, MoreHorizontal } from 'lucide-react';
import { usePlayerStore } from '../store/playerStore';
import MobileSearchOverlay from './MobileSearchOverlay';
import MobileMoreOverlay from './MobileMoreOverlay';

const NAV_ITEMS = [
  { to: '/',            end: true,  icon: Disc3,      labelKey: 'sidebar.mainstage' },
  { to: '/albums',      end: false, icon: Music4,     labelKey: 'sidebar.allAlbums' },
  { to: '/now-playing', end: false, icon: AudioLines, labelKey: 'sidebar.nowPlaying' },
] as const;

export default function BottomNav() {
  const { t } = useTranslation();
  const isPlaying    = usePlayerStore(s => s.isPlaying);
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const [searchOpen, setSearchOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <>
      <nav className="bottom-nav" aria-label="Mobile navigation">
        {NAV_ITEMS.map(({ to, end, icon: Icon, labelKey }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `bottom-nav-item${isActive ? ' active' : ''}`}
          >
            <span className="bottom-nav-icon-wrap">
              <Icon size={22} />
              {to === '/now-playing' && isPlaying && currentTrack && (
                <span className="bottom-nav-np-dot" />
              )}
            </span>
            <span className="bottom-nav-label">{t(labelKey)}</span>
          </NavLink>
        ))}

        <button
          className="bottom-nav-item"
          onClick={() => setSearchOpen(true)}
          aria-label={t('search.title')}
        >
          <span className="bottom-nav-icon-wrap">
            <Search size={22} />
          </span>
          <span className="bottom-nav-label">{t('search.title')}</span>
        </button>

        <button
          className={`bottom-nav-item${moreOpen ? ' active' : ''}`}
          onClick={() => setMoreOpen(v => !v)}
          aria-label={t('sidebar.more')}
        >
          <span className="bottom-nav-icon-wrap">
            <MoreHorizontal size={22} />
          </span>
          <span className="bottom-nav-label">{t('sidebar.more')}</span>
        </button>
      </nav>

      {searchOpen && <MobileSearchOverlay onClose={() => setSearchOpen(false)} />}
      {moreOpen && <MobileMoreOverlay onClose={() => setMoreOpen(false)} />}
    </>
  );
}
