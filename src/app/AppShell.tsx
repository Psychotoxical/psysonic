import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
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
import { cleanupOrphanedOrbitPlaylists } from '../utils/orbit';
import { useOrbitStore } from '../store/orbitStore';
import { IS_LINUX, IS_MACOS, IS_WINDOWS } from '../utils/platform';
import { useConnectionStatus } from '../hooks/useConnectionStatus';
import { useAuthStore } from '../store/authStore';
import { getMusicFolders, probeEntityRatingSupport } from '../api/subsonic';
import { useOfflineStore } from '../store/offlineStore';
import { usePlayerStore } from '../store/playerStore';
import { useThemeStore } from '../store/themeStore';
import { useFontStore } from '../store/fontStore';
import { useEqStore } from '../store/eqStore';
import { usePerfProbeFlags } from '../utils/perfFlags';

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'psysonic_sidebar_collapsed';

function readInitialSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function persistSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Ignore storage failures and keep in-memory UI state.
  }
}

/**
 * Avoid grabbing the queue resizer when aiming at the main overlay scrollbar.
 * Uses the real main viewport edge (not innerWidth − queueWidth — sidebar/zoom skew that).
 * Only the main-route thumb counts (not queue/mini/sidebar thumbs — selector is scoped).
 *
 * The queue resizer is 6px and sits on the main|queue seam with ~3px overlapping the main
 * column (layout.css `.resizer-queue`). Treating `clientX <= mainRight` as "main" suppressed
 * that overlap and felt like a dead resize strip at certain widths. Thumb hit slop must not
 * extend past `mainRight` or it steals grabs on the resizer.
 */
function shouldSuppressQueueResizerMouseDown(clientX: number, clientY: number, queueWidth: number): boolean {
  const vp = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID) as HTMLElement | null;
  const mainRight = vp ? vp.getBoundingClientRect().right : window.innerWidth - queueWidth;
  /** Pixels of the resizer that lie left of the main column's right edge (see `.resizer-queue`). */
  const RESIZER_BLEED_INTO_MAIN = 4;

  if (clientX <= mainRight - RESIZER_BLEED_INTO_MAIN) return true;

  const thumbs = document.querySelectorAll<HTMLElement>('.app-shell-route-scroll .overlay-scroll__thumb');
  const xSlop = 22;
  const vPad = 40;
  for (let i = 0; i < thumbs.length; i++) {
    const thumb = thumbs[i];
    const style = window.getComputedStyle(thumb);
    const pointerActive = style.pointerEvents !== 'none';
    const visible = Number.parseFloat(style.opacity || '0') > 0.01;
    if (!pointerActive && !visible) continue;

    const r = thumb.getBoundingClientRect();
    if (r.height < 4 || r.width < 1) continue;
    if (clientY < r.top - vPad || clientY > r.bottom + vPad) continue;
    const thumbHitRight = Math.min(r.right + xSlop, mainRight);
    if (clientX >= r.left - 6 && clientX <= thumbHitRight) return true;
  }
  return false;
}

/**
 * The main webview's persistent layout: titlebar (Linux only) + sidebar +
 * main content area (header + route host + offline banner) + queue panel +
 * player bar + fullscreen overlay + global modals + tray-tooltip / title
 * sync. Mounted under `<RequireAuth>` and shared across all routes.
 */
export function AppShell() {
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(false);
  const [isTilingWm, setIsTilingWm] = useState(false);

  // Orbit session hooks: idle until the local store marks a role.
  useOrbitHost();
  useOrbitGuest();

  // Body-level marker so global CSS can hide controls that don't make sense
  // in an Orbit session (e.g. track preview — the preview engine and the
  // shared playback would step on each other). Active for any role + any
  // pre-`active` phase so the marker covers the whole join lifecycle.
  const orbitRole = useOrbitStore(s => s.role);
  const orbitPhase = useOrbitStore(s => s.phase);
  useEffect(() => {
    const inOrbit = (orbitRole === 'host' || orbitRole === 'guest')
      && (orbitPhase === 'active' || orbitPhase === 'joining' || orbitPhase === 'starting');
    if (inOrbit) {
      document.documentElement.setAttribute('data-orbit-active', 'true');
      // Also expose the role so CSS can target host-vs-guest UI states
      // (e.g. guest seekbar is read-only — sync follows the host).
      document.documentElement.setAttribute('data-orbit-role', orbitRole as string);
    } else {
      document.documentElement.removeAttribute('data-orbit-active');
      document.documentElement.removeAttribute('data-orbit-role');
    }
  }, [orbitRole, orbitPhase]);

  useEffect(() => {
    if (!IS_LINUX) return;
    invoke<boolean>('is_tiling_wm_cmd').then(setIsTilingWm).catch(() => {});
  }, []);

  useEffect(() => {
    if (!IS_LINUX) return;
    invoke<boolean>('no_compositing_mode').then(noComp => {
      if (noComp) document.documentElement.classList.add('no-compositing');
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const platform = IS_LINUX ? 'linux' : IS_MACOS ? 'macos' : IS_WINDOWS ? 'windows' : 'unknown';
    document.documentElement.setAttribute('data-platform', platform);
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    // Check initial state (e.g. app launched maximised / already fullscreen).
    win.isFullscreen().then(setIsWindowFullscreen).catch(() => {});
    let unlisten: (() => void) | undefined;
    // onResized fires on every size change, including fullscreen enter/exit on
    // all platforms.  We re-query isFullscreen() rather than inferring from
    // the size so the flag is always accurate regardless of platform quirks.
    win.onResized(() => {
      win.isFullscreen().then(setIsWindowFullscreen).catch(() => {});
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);
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
  const isLoggedIn = useAuthStore(s => s.isLoggedIn);
  const activeServerId = useAuthStore(s => s.activeServerId);
  const setMusicFolders = useAuthStore(s => s.setMusicFolders);
  const useCustomTitlebar = useAuthStore(s => s.useCustomTitlebar);
  const linuxWebkitKineticScroll = useAuthStore(s => s.linuxWebkitKineticScroll);
  const loggingMode = useAuthStore(s => s.loggingMode);
  const setEntityRatingSupport = useAuthStore(s => s.setEntityRatingSupport);
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

  // Sync custom titlebar preference with native decorations on Linux
  // On tiling WMs decorations are always off (no native title bar to replace).
  useEffect(() => {
    if (!IS_LINUX) return;
    const enabled = isTilingWm ? false : !useCustomTitlebar;
    invoke('set_window_decorations', { enabled }).catch(() => {});
  }, [useCustomTitlebar, isTilingWm]);

  useEffect(() => {
    if (!IS_LINUX) return;
    invoke('set_linux_webkit_smooth_scrolling', { enabled: linuxWebkitKineticScroll }).catch(() => {});
  }, [linuxWebkitKineticScroll]);

  useEffect(() => {
    invoke('set_logging_mode', { mode: loggingMode }).catch(() => {});
  }, [loggingMode]);

  useEffect(() => {
    if (!isLoggedIn || !activeServerId) return;
    const serverAtStart = activeServerId;
    let cancelled = false;
    (async () => {
      const stillThisServer = () => !cancelled && useAuthStore.getState().activeServerId === serverAtStart;
      try {
        const folders = await getMusicFolders();
        if (stillThisServer()) setMusicFolders(folders);
      } catch {
        if (stillThisServer()) setMusicFolders([]);
      }
      try {
        const level = await probeEntityRatingSupport();
        if (stillThisServer()) setEntityRatingSupport(serverAtStart, level);
      } catch {
        if (stillThisServer()) setEntityRatingSupport(serverAtStart, 'track_only');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, activeServerId, setMusicFolders, setEntityRatingSupport]);

  // Orbit orphan sweep — delete our own leftover session / outbox playlists
  // from crashed or force-closed sessions so they don't clutter the ND
  // playlist view. Runs once per login; safe and best-effort.
  useEffect(() => {
    if (!isLoggedIn || !activeServerId) return;
    void cleanupOrphanedOrbitPlaylists();
  }, [isLoggedIn, activeServerId]);

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

  useEffect(() => {
    const fn = async () => {
      try {
        const appWindow = getCurrentWindow();
        if (currentTrack) {
          const state = isPlaying ? '▶' : '⏸';
          const title = `${state} ${currentTrack.artist} - ${currentTrack.title} | Psysonic`;
          document.title = title;
          await appWindow.setTitle(title);
          await invoke('set_tray_tooltip', {
            tooltip: `${currentTrack.artist} – ${currentTrack.title}`,
            playbackState: isPlaying ? 'play' : 'pause',
          }).catch(() => {});
        } else {
          document.title = 'Psysonic';
          await appWindow.setTitle('Psysonic');
          await invoke('set_tray_tooltip', {
            tooltip: '',
            playbackState: 'stop',
          }).catch(() => {});
        }
      } catch (err) {}
    };
    fn();
  }, [currentTrack, isPlaying]);

  useEffect(() => {
    const apply = () => {
      invoke('set_tray_menu_labels', {
        playPause: t('tray.playPause'),
        next: t('tray.nextTrack'),
        previous: t('tray.previousTrack'),
        showHide: t('tray.showHide'),
        quit: t('tray.exitPsysonic'),
        nothingPlaying: t('tray.nothingPlaying'),
      }).catch(() => {});
    };
    apply();
    i18n.on('languageChanged', apply);
    return () => { i18n.off('languageChanged', apply); };
  }, [t, i18n]);

  // Post-update changelog is now surfaced via a dismissible banner in the
  // sidebar (WhatsNewBanner) that links to the /whats-new page — no auto
  // modal takeover on startup.

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(readInitialSidebarCollapsed);
  const [queueWidth, setQueueWidth] = useState(340);
  const [isDraggingQueue, setIsDraggingQueue] = useState(false);
  const [queueHandleTop, setQueueHandleTop] = useState<number | null>(null);
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

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (isDraggingQueue) {
      const newWidth = Math.max(310, Math.min(window.innerWidth - e.clientX, 500));
      setQueueWidth(newWidth);
    }
  }, [isDraggingQueue]);

  const handleMouseUp = useCallback(() => {
    setIsDraggingQueue(false);
  }, []);

  useEffect(() => {
    if (isDraggingQueue) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.classList.add('is-dragging');
    } else {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'default';
      document.body.classList.remove('is-dragging');
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.classList.remove('is-dragging');
    };
  }, [isDraggingQueue, handleMouseMove, handleMouseUp]);

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

  const syncQueueHandleTop = useCallback(() => {
    const leftBtn = document.querySelector('.sidebar .collapse-btn') as HTMLElement | null;
    if (!leftBtn) return;
    const r = leftBtn.getBoundingClientRect();
    setQueueHandleTop(r.top + r.height / 2);
  }, []);

  useEffect(() => {
    if (isMobile) return;
    const leftBtn = document.querySelector('.sidebar .collapse-btn') as HTMLElement | null;
    if (!leftBtn) return;

    syncQueueHandleTop();
    const raf = requestAnimationFrame(syncQueueHandleTop);

    const onResize = () => syncQueueHandleTop();
    window.addEventListener('resize', onResize);
    const observer = new ResizeObserver(onResize);
    observer.observe(leftBtn);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      observer.disconnect();
    };
  }, [isMobile, isSidebarCollapsed, syncQueueHandleTop]);

  const handleQueueHandleMouseDown = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const DRAG_THRESHOLD_PX = 4;
    const startX = e.clientX;
    const startY = e.clientY;
    let didDrag = false;

    const cleanup = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp, true);
      document.body.style.cursor = '';
      document.body.classList.remove('is-dragging');
    };

    const applyWidthFromClientX = (clientX: number) => {
      const newWidth = Math.max(310, Math.min(window.innerWidth - clientX, 500));
      setQueueWidth(newWidth);
    };

    const onMove = (me: MouseEvent) => {
      const movedEnough = Math.hypot(me.clientX - startX, me.clientY - startY) >= DRAG_THRESHOLD_PX;
      if (!didDrag && movedEnough) {
        didDrag = true;
        if (!isQueueVisible) toggleQueue();
        document.body.style.cursor = 'col-resize';
        document.body.classList.add('is-dragging');
      }
      if (!didDrag) return;
      applyWidthFromClientX(me.clientX);
    };

    const onUp = () => {
      cleanup();
      if (!didDrag) toggleQueue();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, true);
  }, [isQueueVisible, toggleQueue]);

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
