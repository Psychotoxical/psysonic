import { createPortal } from 'react-dom';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Settings, HardDriveDownload } from 'lucide-react';
import { useSidebarStore } from '../store/sidebarStore';
import { useAuthStore } from '../store/authStore';
import { useOfflineStore } from '../store/offlineStore';
import { ALL_NAV_ITEMS } from '../config/navItems';

const BOTTOM_NAV_ROUTES = new Set(['/', '/albums', '/now-playing']);

export default function MobileMoreOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const sidebarItems = useSidebarStore(s => s.items);
  const randomNavMode = useAuthStore(s => s.randomNavMode);
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const offlineAlbums = useOfflineStore(s => s.albums);
  const hasOfflineContent = Object.values(offlineAlbums).some(a => a.serverId === serverId);

  const items = sidebarItems
    .filter(cfg => {
      if (!cfg?.visible) return false;
      const item = ALL_NAV_ITEMS[cfg.id];
      if (!item) return false;
      if (BOTTOM_NAV_ROUTES.has(item.to)) return false;
      if (randomNavMode === 'hub' && (cfg.id === 'randomMix' || cfg.id === 'randomAlbums')) return false;
      if (randomNavMode === 'separate' && cfg.id === 'randomPicker') return false;
      return true;
    })
    .map(cfg => ALL_NAV_ITEMS[cfg.id]);

  return createPortal(
    <>
      <div className="mobile-more-backdrop" onClick={onClose} />
      <div className="mobile-more-sheet">
        <div className="mobile-more-handle" />
        <div className="mobile-more-grid">
          {items.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `mobile-more-item${isActive ? ' active' : ''}`}
              onClick={onClose}
            >
              <span className="mobile-more-icon"><item.icon size={24} /></span>
              <span className="mobile-more-label">{t(item.labelKey)}</span>
            </NavLink>
          ))}
          {hasOfflineContent && (
            <NavLink
              to="/offline"
              className={({ isActive }) => `mobile-more-item${isActive ? ' active' : ''}`}
              onClick={onClose}
            >
              <span className="mobile-more-icon"><HardDriveDownload size={24} /></span>
              <span className="mobile-more-label">{t('sidebar.offlineLibrary')}</span>
            </NavLink>
          )}
          <NavLink
            to="/settings"
            className={({ isActive }) => `mobile-more-item${isActive ? ' active' : ''}`}
            onClick={onClose}
          >
            <span className="mobile-more-icon"><Settings size={24} /></span>
            <span className="mobile-more-label">{t('sidebar.settings')}</span>
          </NavLink>
        </div>
      </div>
    </>,
    document.body
  );
}
