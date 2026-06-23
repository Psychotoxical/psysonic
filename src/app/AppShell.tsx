import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ensurePlaybackServerActive } from '../utils/playback/playbackServer';
import { navigatePathWithAlbumReturnTo, shouldSkipMainScrollResetOnRouteChange } from '../utils/navigation/albumDetailNavigation';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { PanelRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Sidebar from '../components/Sidebar';
import PlayerBar from '../components/PlayerBar';
import BottomNav from '../components/BottomNav';
import { useIsMobile } from '../hooks/useIsMobile';
import LiveSearch from '../components/LiveSearch';
import DevNetworkModeToggle from '../components/DevNetworkModeToggle';
import NowPlayingDropdown from '../components/NowPlayingDropdown';
import QueuePanel from '../components/QueuePanel';
import AppRoutes from './AppRoutes';
import FullscreenPlayer from '../components/fullscreenPlayer/FullscreenPlayerStatic';
import ContextMenu from '../components/ContextMenu';
import SongInfoModal from '../components/SongInfoModal';
import DownloadFolderModal from '../components/DownloadFolderModal';
import GlobalConfirmModal from '../components/GlobalConfirmModal';
import ThemeMigrationNotice from '../components/ThemeMigrationNotice';
import OrbitAccountPicker from '../components/OrbitAccountPicker';
import OrbitHelpModal from '../components/OrbitHelpModal';
import TooltipPortal from '../components/TooltipPortal';
import OverlayScrollArea from '../components/OverlayScrollArea';
import {
  APP_MAIN_SCROLL_VIEWPORT_ID,
  mainRouteInpageScrollViewportId,
} from '../constants/appScroll';
import ConnectionIndicator from '../components/ConnectionIndicator';
import MusicNetworkIndicator from '../components/MusicNetworkIndicator';
import OfflineBanner from '../components/OfflineBanner';
import AppUpdater from '../components/AppUpdater';
import TitleBar from '../components/TitleBar';
import OrbitSessionBar from '../components/OrbitSessionBar';
import OrbitStartTrigger from '../components/OrbitStartTrigger';
import { useOrbitHost } from '../hooks/useOrbitHost';
import { useOrbitGuest } from '../hooks/useOrbitGuest';
import { useOrbitBodyAttrs } from '../hooks/useOrbitBodyAttrs';
import { usePlatformShellSetup } from '../hooks/usePlatformShellSetup';
import { useOfflineBrowseContext } from '../hooks/useOfflineBrowseContext';
import { offlineBrowseNavFlags } from '../utils/offline/offlineBrowseContext';
import { useWindowFullscreenState } from '../hooks/useWindowFullscreenState';
import { useNowPlayingTrayTitle } from '../hooks/useNowPlayingTrayTitle';
import { usePrefetchReleaseNotes } from '../hooks/usePrefetchReleaseNotes';
import { useTrayMenuI18n } from '../hooks/useTrayMenuI18n';
import { useServerCapabilitiesProbe } from '../hooks/useServerCapabilitiesProbe';
import { useQueueResizer } from '../hooks/useQueueResizer';
import { useGlobalDndAndSelectionBlockers } from '../hooks/useGlobalDndAndSelectionBlockers';
import { useAppActivityTracking } from '../hooks/useAppActivityTracking';
import { useMainScrollingIndicator } from '../hooks/useMainScrollingIndicator';
import { useCoverNavigationPriority } from '../hooks/useCoverNavigationPriority';
import { useLiveSearchRouteScope } from '../hooks/useLiveSearchRouteScope';
import { useNowPlayingPrewarm } from '../hooks/useNowPlayingPrewarm';
import { useOfflineAutoNav } from '../hooks/useOfflineAutoNav';
import { useOfflineLibraryFilterSuspend } from '../hooks/useOfflineLibraryFilterSuspend';
import { AppShellQueueResizerSeam } from '../components/AppShellQueueResizerSeam';
import { IS_LINUX } from '../utils/platform';
import { useConnectionStatus } from '../hooks/useConnectionStatus';
import { useIdlePlayQueuePull } from '../hooks/useIdlePlayQueuePull';
import { useAuthStore } from '../store/authStore';
import { usePlayerStore } from '../store/playerStore';
import '../store/previewPlayerVolumeSync';
import '../store/queueResolverBridge';
import { useThemeStore } from '../store/themeStore';
import { useFontStore } from '../store/fontStore';
import { useEqStore } from '../store/eqStore';
import { usePlaybackRateStore } from '../store/playbackRateStore';
import { usePlaybackRateOrbitSync } from '../hooks/usePlaybackRateOrbitSync';
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
  usePlaybackRateOrbitSync();
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
  useIdlePlayQueuePull(connStatus);
  const navigate = useNavigate();
  const location = useLocation();
  const prevPathnameRef = useRef(location.pathname);
  useCoverNavigationPriority();
  useLiveSearchRouteScope();
  useNowPlayingPrewarm();
  const useCustomTitlebar = useAuthStore(s => s.useCustomTitlebar);
  const offlineCtx = useOfflineBrowseContext();
  const offlineNav = offlineBrowseNavFlags(offlineCtx.capabilities);
  const hasOfflineBrowse = offlineCtx.hasBrowseCapability;
  const floatingPlayerBar = useThemeStore(s => s.floatingPlayerBar);
  const perfFlags = usePerfProbeFlags();

  // Mini player → main: route requests dispatched as `psy:navigate`
  // CustomEvents from the bridge land here so React Router can take over.
  useEffect(() => {
    const onPsyNavigate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.to) return;
      void ensurePlaybackServerActive().then(ok => {
        if (ok) navigatePathWithAlbumReturnTo(navigate, location, detail.to);
      });
    };
    window.addEventListener('psy:navigate', onPsyNavigate);
    return () => window.removeEventListener('psy:navigate', onPsyNavigate);
  }, [navigate, location]);

  // Reset scroll on route change only — not when the same path gets a new location.state
  // (Advanced Search strips `advancedSearchRestore` after applying saved scroll).
  useEffect(() => {
    const pathnameChanged = prevPathnameRef.current !== location.pathname;
    prevPathnameRef.current = location.pathname;
    if (!pathnameChanged) return;
    if (shouldSkipMainScrollResetOnRouteChange(location.pathname, location.state)) return;
    document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID)?.scrollTo({ top: 0 });
  }, [location.pathname, location.state]);

  useOfflineAutoNav(connStatus, offlineNav, location, navigate);
  useOfflineLibraryFilterSuspend();

  useEffect(() => {
    initializeFromServerQueue();
  }, [initializeFromServerQueue]);

  useEffect(() => {
    useEqStore.getState().syncToRust();
    usePlaybackRateStore.getState().syncToRust();
  }, []);


  useEffect(() => {
    getCurrentWebview().setZoom(uiScale).catch(() => {
      /* setZoom may fail on platforms where the capability is unavailable;
         fall back silently so the rest of the shell still renders. */
    });
  }, [uiScale]);

  useNowPlayingTrayTitle(currentTrack, isPlaying);

  // Post-update changelog is now surfaced via a dismissible banner in the
  // sidebar (WhatsNewBanner) that links to the /whats-new page — no auto
  // modal takeover on startup.
  usePrefetchReleaseNotes();

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

  // Expose sidebar state on the theme root so themes can react with a
  // `[data-theme='x'][data-sidebar-collapsed='true']` compound (contract
  // `stateSelectors`). Other state attributes are set in App.tsx.
  useEffect(() => {
    document.documentElement.setAttribute('data-sidebar-collapsed', isSidebarCollapsed ? 'true' : 'false');
  }, [isSidebarCollapsed]);

  // Workaround for WebKitGTK 2.50.x text-input repaint hang on
  // Linux Mint / Ubuntu 24.04 (issues #342, #782). When opted in,
  // nudge WebKit awake on every input/textarea focus via a sync
  // reflow read plus a one-frame translateZ(0) toggle on the input's
  // parent so the rendering pipeline re-evaluates the layer tree.
  // Side-effect: search magnifier flickers briefly on focus.
  const linuxWebkitInputForceRepaint = useAuthStore(s => s.linuxWebkitInputForceRepaint);
  useEffect(() => {
    if (!linuxWebkitInputForceRepaint) return;
    const handler = (e: FocusEvent) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const tag = target.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') return;
      const layerHost = (target.parentElement as HTMLElement | null) ?? target;
      void layerHost.offsetHeight;
      const previous = layerHost.style.transform;
      layerHost.style.transform = 'translateZ(0)';
      requestAnimationFrame(() => {
        layerHost.style.transform = previous;
      });
    };
    document.addEventListener('focusin', handler, true);
    return () => document.removeEventListener('focusin', handler, true);
  }, [linuxWebkitInputForceRepaint]);

  const {
    queueWidth,
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
      {import.meta.env.DEV && isMobile && (
        <span className="dev-build-badge" aria-hidden>DEV</span>
      )}
      {!isMobile && (
        <Sidebar
          isCollapsed={isSidebarCollapsed}
          toggleCollapse={() => setSidebarCollapsed(!isSidebarCollapsed)}
        />
      )}
      <main className="main-content">
        <div className="main-content-zoom">
        <header className="content-header">
          <LiveSearch />
          {import.meta.env.DEV && <DevNetworkModeToggle />}
          <div className="spacer" />
          <ConnectionIndicator status={connStatus} isLan={isLan} serverName={serverName} />
          <MusicNetworkIndicator />
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
          <OfflineBanner onRetry={connRetry} isChecking={connRetrying} showSettingsLink={!hasOfflineBrowse} serverName={serverName} />
        )}
        <div className="content-body app-shell-route-host">
          <OverlayScrollArea
            className="app-shell-route-scroll"
            viewportClassName={
              mainRouteInpageScrollViewportId(location.pathname)
                ? 'app-shell-route-scroll__viewport app-shell-route-scroll__viewport--inpage-split'
                : 'app-shell-route-scroll__viewport'
            }
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
      <ThemeMigrationNotice />
      <OrbitAccountPicker />
      <OrbitHelpModal />
      {!perfFlags.disableTooltipPortal && <TooltipPortal />}
      <AppUpdater />
    </div>
  );
}

export default AppShell;
