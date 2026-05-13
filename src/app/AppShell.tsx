import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { PanelRight, PanelRightClose } from 'lucide-react';
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
import { useWindowFullscreenState } from '../hooks/useWindowFullscreenState';
import { useNowPlayingTrayTitle } from '../hooks/useNowPlayingTrayTitle';
import { useTrayMenuI18n } from '../hooks/useTrayMenuI18n';
import { useServerCapabilitiesProbe } from '../hooks/useServerCapabilitiesProbe';
import { useQueueResizer } from '../hooks/useQueueResizer';
import { IS_LINUX } from '../utils/platform';
import { useConnectionStatus } from '../hooks/useConnectionStatus';
import { useAuthStore } from '../store/authStore';
import { useOfflineStore } from '../store/offlineStore';
import { usePlayerStore } from '../store/playerStore';
import { useThemeStore } from '../store/themeStore';
import { useFontStore } from '../store/fontStore';
import { useEqStore } from '../store/eqStore';
import { usePerfProbeFlags } from '../utils/perfFlags';
import {
  persistSidebarCollapsed,
  readInitialSidebarCollapsed,
  shouldSuppressQueueResizerMouseDown,
} from '../utils/appShellHelpers';

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
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const useCustomTitlebar = useAuthStore(s => s.useCustomTitlebar);
  const offlineAlbums = useOfflineStore(s => s.albums);
  const hasOfflineContent = Object.values(offlineAlbums).some(a => a.serverId === serverId);
  const floatingPlayerBar = useThemeStore(s => s.floatingPlayerBar);
  const perfFlags = usePerfProbeFlags();

  // Mini player → main: route requests dispatched as `psy:navigate`
  // CustomEvents from the bridge land here so React Router can take over.
  useEffect(() => {
    const onPsyNavigate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.to) navigate(detail.to);
    };
    window.addEventListener('psy:navigate', onPsyNavigate);
    return () => window.removeEventListener('psy:navigate', onPsyNavigate);
  }, [navigate]);

  // Reset scroll position on route change (main viewport is overlay scroll)
  useEffect(() => {
    document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID)?.scrollTo({ top: 0 });
  }, [location.pathname]);

  // Auto-navigate to offline library when no connection but cached content exists
  const prevConnStatus = useRef(connStatus);
  useEffect(() => {
    const prev = prevConnStatus.current;
    prevConnStatus.current = connStatus;

    if (connStatus === 'disconnected' && hasOfflineContent && prev !== 'disconnected') {
      navigate('/offline', { replace: true });
    }
    // Return from offline page only when reconnecting (not when user navigates there manually while online)
    if (connStatus === 'connected' && prev === 'disconnected' && location.pathname === '/offline') {
      navigate('/', { replace: true });
    }
  }, [connStatus, hasOfflineContent, location.pathname, navigate]);

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
  const [isMainScrolling, setIsMainScrolling] = useState(false);

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

  useEffect(() => {
    const viewports = new Set<HTMLElement>();
    const appViewport = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID);
    if (appViewport) viewports.add(appViewport);
    const nowPlayingViewport = document.querySelector<HTMLElement>('.np-main__viewport');
    if (nowPlayingViewport) viewports.add(nowPlayingViewport);
    if (viewports.size === 0) return;

    let scrollHideTimer: number | null = null;

    const onScroll = () => {
      setIsMainScrolling(true);
      if (scrollHideTimer != null) window.clearTimeout(scrollHideTimer);
      scrollHideTimer = window.setTimeout(() => {
        setIsMainScrolling(false);
        scrollHideTimer = null;
      }, 180);
    };

    viewports.forEach(viewport => {
      viewport.addEventListener('scroll', onScroll, { passive: true });
    });
    return () => {
      viewports.forEach(viewport => {
        viewport.removeEventListener('scroll', onScroll);
      });
      if (scrollHideTimer != null) window.clearTimeout(scrollHideTimer);
      setIsMainScrolling(false);
    };
  }, [location.pathname]);

  // ── Global DnD fix for Linux/WebKitGTK / Wayland ─────────────────
  // dragover/dragenter: WebKitGTK needs preventDefault so external drops are not
  // a permanent "forbidden" cursor. dragstart (capture): cancel native drags from
  // the page (e.g. SVG grips); Wayland can otherwise leave a stuck GTK drag-proxy.
  // In-app moves use psy-drag (mouse events). Harmless on Windows/macOS.
  useEffect(() => {
    const allow = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    // Prevent the webview from navigating when something (e.g. a file
    // from the OS file manager) is dropped on the document body.
    const blockDrop = (e: DragEvent) => { e.preventDefault(); };

    // Block Ctrl+A / Cmd+A "select all" — WebKit ignores user-select:none for keyboard shortcuts
    const blockSelectAll = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        const target = e.target as HTMLElement;
        // Allow Ctrl+A inside actual text inputs and textareas
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
        e.preventDefault();
      }
    };

    // Block mouse drag selection — WebKitGTK ignores user-select:none on * for drag selection
    const blockSelectStart = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      if ((target as HTMLElement).closest('[data-selectable]')) return;
      e.preventDefault();
    };

    const blockDragStart = (e: DragEvent) => {
      e.preventDefault();
    };

    document.addEventListener('dragover', allow);
    document.addEventListener('dragenter', allow);
    document.addEventListener('drop', blockDrop);
    document.addEventListener('dragstart', blockDragStart, true);
    document.addEventListener('keydown', blockSelectAll, true);
    document.addEventListener('selectstart', blockSelectStart);

    return () => {
      document.removeEventListener('dragover', allow);
      document.removeEventListener('dragenter', allow);
      document.removeEventListener('drop', blockDrop);
      document.removeEventListener('dragstart', blockDragStart, true);
      document.removeEventListener('keydown', blockSelectAll, true);
      document.removeEventListener('selectstart', blockSelectStart);
    };
  }, []);

  // Pause CSS animations when the browser tab is hidden (`document.hidden`).
  // Tauri `win.hide()` is mirrored separately via `data-psy-native-hidden` from
  // Rust (see components.css). WebView2 can keep compositing without the former.
  useEffect(() => {
    const update = () => {
      document.documentElement.dataset.appHidden = document.hidden ? 'true' : 'false';
    };
    document.addEventListener('visibilitychange', update);
    update();
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  // Pause cosmetic animations when the window loses OS focus but stays visible
  // (alt-tab, click into another app). On low-VRAM laptops WebView2 keeps
  // compositing mesh blobs / waveform / marquee at full rate even though the
  // user isn't looking — measurable GPU drain reported in issue #334.
  useEffect(() => {
    const update = () => {
      const blurred = !document.hasFocus();
      window.__psyBlurred = blurred;
      document.documentElement.dataset.appBlurred = blurred ? 'true' : 'false';
    };
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    update();
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, []);

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
        <div
          className="resizer resizer-queue"
          onMouseDown={(e) => {
            e.preventDefault();
            if (document.body.classList.contains('is-overlay-scrollbar-thumb-drag')) {
              // Self-heal stale drag flag: if no thumb is actually dragging,
              // unblock the queue resizer immediately.
              const activeThumbDrag = document.querySelector('.overlay-scroll__thumb.is-thumb-dragging');
              if (!activeThumbDrag) {
                document.body.classList.remove('is-overlay-scrollbar-thumb-drag');
              } else {
                return;
              }
            }
            if (shouldSuppressQueueResizerMouseDown(e.clientX, e.clientY, queueWidth)) return;
            setIsDraggingQueue(true);
          }}
          style={{
            display: isQueueVisible ? 'block' : 'none',
            right: `${Math.max(0, queueWidth - 3)}px`,
          }}
        />
      )}
      {!isMobile && isQueueVisible && (
        <button
          type="button"
          className="resizer-queue-handle"
          onMouseDown={handleQueueHandleMouseDown}
          style={{
            position: 'fixed',
            top: queueHandleTop != null ? `${queueHandleTop}px` : '50%',
            right: `${Math.max(0, queueWidth - 11)}px`,
            transform: 'translateY(-50%)',
            zIndex: 101,
            opacity: isMainScrolling ? 0 : 1,
            pointerEvents: isMainScrolling ? 'none' : 'auto',
          }}
          data-tooltip={t('player.collapseQueueResize')}
          data-tooltip-pos="left"
          aria-label={t('player.collapseQueueResize')}
        >
          {isQueueVisible ? <PanelRightClose size={14} /> : <PanelRight size={14} />}
        </button>
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
