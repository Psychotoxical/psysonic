import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ensurePlaybackServerActive } from '../utils/playback/playbackServer';
import { invoke } from '@tauri-apps/api/core';
import { PanelRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import PlayerBar from '../components/PlayerBar';
import BottomNav from '../components/BottomNav';
import { useIsMobile } from '../hooks/useIsMobile';
import LiveSearch from '../components/LiveSearch';
import NowPlayingDropdown from '../components/NowPlayingDropdown';
import QueuePanel from '../components/QueuePanel';
import AppRoutes from './AppRoutes';
import FullscreenPlayer from '../components/FullscreenPlayer';
import ContextMenu from '../components/ContextMenu';
import SongInfoModal from '../components/SongInfoModal';
import DownloadFolderModal from '../components/DownloadFolderModal';
import GlobalConfirmModal from '../components/GlobalConfirmModal';
import OrbitAccountPicker from '../components/OrbitAccountPicker';
import OrbitHelpModal from '../components/OrbitHelpModal';
import TooltipPortal from '../components/TooltipPortal';
import OverlayScrollArea from '../components/OverlayScrollArea';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from '../constants/appScroll';
import ConnectionIndicator from '../components/ConnectionIndicator';
import LastfmIndicator from '../components/LastfmIndicator';
import OfflineBanner from '../components/OfflineBanner';
import AppUpdater from '../components/AppUpdater';
import TitleBar from '../components/TitleBar';
import OrbitSessionBar from '../components/OrbitSessionBar';
import OrbitStartTrigger from '../components/OrbitStartTrigger';
import { useOrbitHost } from '../hooks/useOrbitHost';
import { useOrbitGuest } from '../hooks/useOrbitGuest';
import { useOrbitBodyAttrs } from '../hooks/useOrbitBodyAttrs';
import { usePlatformShellSetup } from '../hooks/usePlatformShellSetup';
import { hasAnyOfflineAlbums } from '../utils/offline/offlineLibraryHelpers';
import { useWindowFullscreenState } from '../hooks/useWindowFullscreenState';
import { useNowPlayingTrayTitle } from '../hooks/useNowPlayingTrayTitle';
import { useTrayMenuI18n } from '../hooks/useTrayMenuI18n';
import { useServerCapabilitiesProbe } from '../hooks/useServerCapabilitiesProbe';
import { useQueueResizer } from '../hooks/useQueueResizer';
import { useGlobalDndAndSelectionBlockers } from '../hooks/useGlobalDndAndSelectionBlockers';
import { useAppActivityTracking } from '../hooks/useAppActivityTracking';
import { useMainScrollingIndicator } from '../hooks/useMainScrollingIndicator';
import { useOfflineAutoNav } from '../hooks/useOfflineAutoNav';
import { AppShellQueueResizerSeam } from '../components/AppShellQueueResizerSeam';
import { IS_LINUX } from '../utils/platform';
import { useConnectionStatus } from '../hooks/useConnectionStatus';
import { useAuthStore } from '../store/authStore';
import { useOfflineStore } from '../store/offlineStore';
import { usePlayerStore } from '../store/playerStore';
import { useThemeStore } from '../store/themeStore';
import { useFontStore } from '../store/fontStore';
import { useEqStore } from '../store/eqStore';
import { usePerfProbeFlags } from '../utils/perf/perfFlags';
import {
  persistSidebarCollapsed,
  readInitialSidebarCollapsed,
} from '../utils/componentHelpers/appShellHelpers';

/**
 * The main webview's persistent layout: titlebar (Linux only) + sidebar +
 * main content area (header + route host + offline banner) + queue panel +
 * player bar + fullscreen overlay + global modals + tray-tooltip / title
 * sync. Mounted under `<RequireAuth>` and shared across all routes.
 */
export function AppShell() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const isWindowFullscreen = useWindowFullscreenState();
  const { isTilingWm } = usePlatformShellSetup();

  // Orbit session hooks: idle until the local store marks a role.
  useOrbitHost();
  useOrbitGuest();
  useOrbitBodyAttrs();
  useTrayMenuI18n();
  useServerCapabilitiesProbe();
  const isFullscreenOpen = usePlayerStore(s => s.isFullscreenOpen);
  const toggleFullscreen = usePlayerStore(s => s.toggleFullscreen);
  const isQueueVisible = usePlayerStore(s => s.isQueueVisible);
  const toggleQueue = usePlayerStore(s => s.toggleQueue);
  const uiScale = useFontStore(s => s.uiScale);
  const initializeFromServerQueue = usePlayerStore(s => s.initializeFromServerQueue);
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const { status: connStatus, isRetrying: connRetrying, retry: connRetry, isLan, serverName } = useConnectionStatus();
  const navigate = useNavigate();
  const location = useLocation();
  const useCustomTitlebar = useAuthStore(s => s.useCustomTitlebar);
  const offlineAlbums = useOfflineStore(s => s.albums);
  const hasOfflineContent = hasAnyOfflineAlbums(offlineAlbums);
  const floatingPlayerBar = useThemeStore(s => s.floatingPlayerBar);
  const perfFlags = usePerfProbeFlags();

  // Mini player → main: route requests dispatched as `psy:navigate`
  // CustomEvents from the bridge land here so React Router can take over.
  useEffect(() => {
    const onPsyNavigate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.to) return;
      void ensurePlaybackServerActive().then(ok => {
        if (ok) navigate(detail.to);
      });
    };
    window.addEventListener('psy:navigate', onPsyNavigate);
    return () => window.removeEventListener('psy:navigate', onPsyNavigate);
  }, [navigate]);

  // Reset scroll position on route change (main viewport is overlay scroll)
  useEffect(() => {
    document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID)?.scrollTo({ top: 0 });
  }, [location.pathname]);

  useOfflineAutoNav(connStatus, hasOfflineContent, location.pathname, navigate);

  useEffect(() => {
    initializeFromServerQueue();
  }, [initializeFromServerQueue]);

  useEffect(() => {
    useEqStore.getState().syncToRust();
  }, []);

  useNowPlayingTrayTitle(currentTrack, isPlaying);

  // Post-update changelog is now surfaced via a dismissible banner in the
  // sidebar (WhatsNewBanner) that links to the /whats-new page — no auto
  // modal takeover on startup.

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(readInitialSidebarCollapsed);
  const isMainScrolling = useMainScrollingIndicator(location.pathname);

  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    persistSidebarCollapsed(collapsed);
    setIsSidebarCollapsed(collapsed);
  }, []);

  useEffect(() => {
    const onToggleSidebar = () => setSidebarCollapsed(!isSidebarCollapsed);
    window.addEventListener('psy:toggle-sidebar', onToggleSidebar);
    return () => window.removeEventListener('psy:toggle-sidebar', onToggleSidebar);
  }, [isSidebarCollapsed, setSidebarCollapsed]);

  const {
    queueWidth,
    isDraggingQueue,
    setIsDraggingQueue,
    queueHandleTop,
    handleQueueHandleMouseDown,
  } = useQueueResizer({ isMobile, isSidebarCollapsed, isQueueVisible, toggleQueue });

  useGlobalDndAndSelectionBlockers();
  useAppActivityTracking();

  const isMobilePlayer = isMobile && location.pathname === '/now-playing';

  return (
    <div
      className={`app-shell ${floatingPlayerBar ? 'floating-player' : ''}`}
      data-mobile={isMobile || undefined}
      data-mobile-player={isMobilePlayer || undefined}
      data-titlebar={(IS_LINUX && useCustomTitlebar && !isWindowFullscreen && !isTilingWm) || undefined}
      data-fullscreen={isWindowFullscreen || undefined}
      style={{
        '--sidebar-width': isMobile ? '0px' : (isSidebarCollapsed ? '72px' : 'clamp(200px, 15vw, 220px)'),
        '--queue-width': isMobile
          ? '0px'
          : (isQueueVisible ? `${queueWidth}px` : '0px')
      } as React.CSSProperties}
      onContextMenu={e => e.preventDefault()}
    >
      {IS_LINUX && useCustomTitlebar && !isWindowFullscreen && !isTilingWm && <TitleBar />}
      {!isMobile && (
        <Sidebar
          isCollapsed={isSidebarCollapsed}
          toggleCollapse={() => setSidebarCollapsed(!isSidebarCollapsed)}
        />
      )}
      <main className="main-content">
        <div className="main-content-zoom" style={uiScale !== 1 ? { zoom: uiScale } : undefined}>
        <header className="content-header">
          <LiveSearch />
          <div className="spacer" />
          <ConnectionIndicator status={connStatus} isLan={isLan} serverName={serverName} />
          <LastfmIndicator />
          <NowPlayingDropdown />
          <OrbitStartTrigger />
          {!isMobile && !isQueueVisible && (
            <button
              className="queue-toggle-btn"
              onClick={toggleQueue}
              data-tooltip={t('player.toggleQueue')}
              data-tooltip-pos="bottom"
            >
              <PanelRight size={18} />
            </button>
          )}
        </header>
        <OrbitSessionBar />
        {connStatus === 'disconnected' && (
          <OfflineBanner onRetry={connRetry} isChecking={connRetrying} showSettingsLink={!hasOfflineContent} serverName={serverName} />
        )}
        <div className="content-body app-shell-route-host">
          <OverlayScrollArea
            className="app-shell-route-scroll"
            viewportClassName="app-shell-route-scroll__viewport"
            viewportId={APP_MAIN_SCROLL_VIEWPORT_ID}
            measureDeps={[location.pathname, isQueueVisible, queueWidth, floatingPlayerBar]}
            railInset="panel"
          >
            <Suspense fallback={null}>
              {perfFlags.disableMainRouteContentMount ? (
                <div style={{ minHeight: '60vh' }} />
              ) : (
                <AppRoutes />
              )}
            </Suspense>
          </OverlayScrollArea>
        </div>
        </div>
      </main>
      {!isMobile && (
        <AppShellQueueResizerSeam
          isQueueVisible={isQueueVisible}
          queueWidth={queueWidth}
          queueHandleTop={queueHandleTop}
          isMainScrolling={isMainScrolling}
          setIsDraggingQueue={setIsDraggingQueue}
          handleQueueHandleMouseDown={handleQueueHandleMouseDown}
          t={t}
        />
      )}
      {!isMobile && !perfFlags.disableQueuePanelMount && <QueuePanel />}
      {isMobile && !isMobilePlayer && <BottomNav />}
      {!isMobilePlayer && <PlayerBar />}
      {isFullscreenOpen && (
        <FullscreenPlayer onClose={toggleFullscreen} />
      )}
      <ContextMenu />
      <SongInfoModal />
      <DownloadFolderModal />
      <GlobalConfirmModal />
      <OrbitAccountPicker />
      <OrbitHelpModal />
      {!perfFlags.disableTooltipPortal && <TooltipPortal />}
      <AppUpdater />
    </div>
  );
}

export default AppShell;
