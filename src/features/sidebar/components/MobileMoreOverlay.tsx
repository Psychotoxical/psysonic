import { createPortal } from 'react-dom';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Settings, HardDriveDownload } from 'lucide-react';
import { useSidebarStore } from '@/features/sidebar';
import { useAuthStore } from '@/store/authStore';
import { ALL_NAV_ITEMS } from '@/config/navItems';
import { useLuckyMixAvailable } from '@/features/randomMix';
import { isOfflineSidebarNavAllowed } from '@/features/offline';
import { useOfflineBrowseContext } from '@/features/offline';
import { offlineBrowseNavFlags } from '@/features/offline';

const BOTTOM_NAV_ROUTES = new Set(['/', '/albums', '/now-playing']);

export default function MobileMoreOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const sidebarItems = useSidebarStore(s => s.items);
  const randomNavMode = useAuthStore(s => s.randomNavMode);
  const offlineCtx = useOfflineBrowseContext();
  const offlineNav = offlineBrowseNavFlags(offlineCtx.capabilities);
  const isServerOffline = offlineCtx.active;
  const hasOfflineContent = offlineCtx.capabilities.manualPins;
  const luckyMixBase = useLuckyMixAvailable();
  const luckyMixAvailable = luckyMixBase && randomNavMode === 'separate';

  const items = sidebarItems
    .filter(cfg => {
      if (!cfg?.visible) return false;
      const item = ALL_NAV_ITEMS[cfg.id];
      if (!item) return false;
      if (BOTTOM_NAV_ROUTES.has(item.to)) return false;
      if (randomNavMode === 'hub' && (cfg.id === 'randomMix' || cfg.id === 'randomAlbums')) return false;
      if (randomNavMode === 'separate' && cfg.id === 'randomPicker') return false;
      if (cfg.id === 'luckyMix' && !luckyMixAvailable) return false;
      if (isServerOffline && !isOfflineSidebarNavAllowed(
        cfg.id,
        offlineNav.favoritesOfflineBrowse,
        offlineNav.localLibraryBrowse,
        offlineNav.playerStatsBrowse,
        offlineNav.playlistsOfflineBrowse,
      )) {
        return false;
      }
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
