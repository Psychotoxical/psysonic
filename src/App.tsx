import React, { useEffect, useState, useCallback, useRef, Suspense } from 'react';
import { showToast } from './utils/toast';
import { useNavigate, useLocation } from 'react-router-dom';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PanelRight, PanelRightClose } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Sidebar from './components/Sidebar';
import PlayerBar from './components/PlayerBar';
import BottomNav from './components/BottomNav';
import { useIsMobile } from './hooks/useIsMobile';
import LiveSearch from './components/LiveSearch';
import NowPlayingDropdown from './components/NowPlayingDropdown';
import QueuePanel from './components/QueuePanel';
import AppRoutes from './app/AppRoutes';
import FullscreenPlayer from './components/FullscreenPlayer';
import ContextMenu from './components/ContextMenu';
import SongInfoModal from './components/SongInfoModal';
import DownloadFolderModal from './components/DownloadFolderModal';
import GlobalConfirmModal from './components/GlobalConfirmModal';
import OrbitAccountPicker from './components/OrbitAccountPicker';
import OrbitHelpModal from './components/OrbitHelpModal';
import TooltipPortal from './components/TooltipPortal';
import OverlayScrollArea from './components/OverlayScrollArea';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from './constants/appScroll';
import ConnectionIndicator from './components/ConnectionIndicator';
import LastfmIndicator from './components/LastfmIndicator';
import OfflineBanner from './components/OfflineBanner';
import AppUpdater from './components/AppUpdater';
import TitleBar from './components/TitleBar';
import OrbitSessionBar from './components/OrbitSessionBar';
import OrbitStartTrigger from './components/OrbitStartTrigger';
import { useOrbitHost } from './hooks/useOrbitHost';
import { useOrbitGuest } from './hooks/useOrbitGuest';
import { cleanupOrphanedOrbitPlaylists, endOrbitSession, leaveOrbitSession } from './utils/orbit';
import { useOrbitStore } from './store/orbitStore';
import { IS_LINUX, IS_MACOS, IS_WINDOWS } from './utils/platform';
import { useConnectionStatus } from './hooks/useConnectionStatus';
import { useAuthStore } from './store/authStore';
import {
  getMusicFolders,
  getSimilarSongs,
  probeEntityRatingSupport,
  search as subsonicSearch,
} from './api/subsonic';
import { useOfflineStore } from './store/offlineStore';
import i18n from './i18n';
import { switchActiveServer } from './utils/switchActiveServer';
import {
  usePlayerStore,
  getPlaybackProgressSnapshot,
  songToTrack,
  shuffleArray,
  flushPlayQueuePosition,
} from './store/playerStore';
import { useThemeStore } from './store/themeStore';
import { useThemeScheduler } from './hooks/useThemeScheduler';
import { useFontStore } from './store/fontStore';
import { useEqStore } from './store/eqStore';
import { useKeybindingsStore, buildInAppBinding } from './store/keybindingsStore';
import { useGlobalShortcutsStore } from './store/globalShortcutsStore';
import { useZipDownloadStore } from './store/zipDownloadStore';
import { usePreviewStore } from './store/previewStore';
import { DEFAULT_IN_APP_BINDINGS, canRunShortcutActionInMiniWindow, executeCliPlayerCommand, executeRuntimeAction, isGlobalShortcutActionId, isShortcutAction } from './config/shortcutActions';
import { matchInAppShortcutAction } from './shortcuts/runtime';
import { usePerfProbeFlags } from './utils/perfFlags';
import { getWindowKind } from './app/windowKind';
import MiniPlayerApp from './app/MiniPlayerApp';
import MainApp from './app/MainApp';

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

// Media key + tray event handler
export function TauriEventBridge() {
  const navigate = useNavigate();

  // ZIP download progress events from Rust
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ id: string; bytes: number; total: number | null }>('download:zip:progress', e => {
      useZipDownloadStore.getState().updateProgress(e.payload.id, e.payload.bytes, e.payload.total);
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  // Track-preview lifecycle: Rust audio engine emits start/progress/end. The
  // store mirrors them so any tracklist row can render its preview UI.
  useEffect(() => {
    const unlistenFns: Array<() => void> = [];
    listen<string>('audio:preview-start', e => {
      usePreviewStore.getState()._onStart(e.payload);
    }).then(u => unlistenFns.push(u));
    listen<{ id: string; elapsed: number; duration: number }>('audio:preview-progress', e => {
      usePreviewStore.getState()._onProgress(e.payload.id, e.payload.elapsed, e.payload.duration);
    }).then(u => unlistenFns.push(u));
    listen<{ id: string; reason: string }>('audio:preview-end', e => {
      usePreviewStore.getState()._onEnd(e.payload.id);
    }).then(u => unlistenFns.push(u));
    return () => { unlistenFns.forEach(fn => fn()); };
  }, []);

  // Audio output device changed (Bluetooth headphones, USB DAC, etc.)
  // The Rust device-watcher has already reopened the stream on the new device
  // and dropped the old Sink, so we just need to restart playback.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('audio:device-changed', () => {
      const { currentTrack, isPlaying, playTrack, resetAudioPause } = usePlayerStore.getState();
      if (!currentTrack) return;
      if (isPlaying) {
        playTrack(currentTrack);
      } else {
        // Paused: clear warm-pause flag so the next resume uses the cold path
        // (audio_play + seek) which creates a new Sink on the new device.
        resetAudioPause();
      }
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  // Pinned output device was unplugged — Rust already fell back to system default.
  // Clear the stored device so the Settings dropdown resets to "System Default".
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen('audio:device-reset', () => {
      useAuthStore.getState().setAudioOutputDevice(null);
      const { currentTrack, currentTime, isPlaying, playTrack, resetAudioPause } = usePlayerStore.getState();
      if (!currentTrack) return;
      if (isPlaying) {
        playTrack(currentTrack);
      } else {
        resetAudioPause();
      }
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  // CLI: `--player audio-device set …` (forwarded on Linux via single-instance).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>('cli:audio-device-set', async e => {
      const raw = typeof e.payload === 'string' ? e.payload : '';
      const deviceName = raw.length > 0 ? raw : null;
      try {
        await invoke('audio_set_device', { deviceName });
        useAuthStore.getState().setAudioOutputDevice(deviceName);
      } catch {
        /* device open failed — do not persist (same as Settings) */
      }
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  // CLI: `--player mix append|new` from the currently playing track.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>('cli:instant-mix', async e => {
      const mode = e.payload === 'append' ? 'append' : 'new';
      const state = usePlayerStore.getState();
      const song = state.currentTrack;
      if (!song) {
        showToast(i18n.t('contextMenu.cliMixNeedsTrack'), 5000, 'error');
        return;
      }
      const serverId = useAuthStore.getState().activeServerId;
      try {
        const similar = await getSimilarSongs(song.id, 50);
        if (serverId) useAuthStore.getState().setAudiomuseNavidromeIssue(serverId, false);
        const base = similar.filter(s => s.id !== song.id).map(s => songToTrack(s));
        if (mode === 'append') {
          const toAdd = shuffleArray(base.map(t => ({ ...t, autoAdded: true as const })));
          if (toAdd.length > 0) usePlayerStore.getState().enqueue(toAdd);
        } else {
          // New queue from seed: collapse to [song] first, then radio tail (not append onto old queue).
          usePlayerStore.getState().reseedQueueForInstantMix(song);
          const shuffled = shuffleArray(
            base.map(t => ({ ...t, radioAdded: true as const })),
          );
          if (shuffled.length > 0) {
            const aid = song.artistId?.trim() || undefined;
            usePlayerStore.getState().enqueueRadio(shuffled, aid);
          }
        }
      } catch (err) {
        console.error('CLI instant mix failed', err);
        if (serverId) useAuthStore.getState().setAudiomuseNavidromeIssue(serverId, true);
        showToast(i18n.t('contextMenu.instantMixFailed'), 5000, 'error');
      }
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
  }, []);

  // CLI: `--player library list` (Rust polls the JSON file) / `library set`.
  useEffect(() => {
    let u1: (() => void) | undefined;
    let u2: (() => void) | undefined;
    listen('cli:library-list', async () => {
      try {
        const folders = await getMusicFolders();
        const auth = useAuthStore.getState();
        const sid = auth.activeServerId;
        const selected = sid ? (auth.musicLibraryFilterByServer[sid] ?? 'all') : 'all';
        await invoke('cli_publish_library_list', {
          payload: {
            folders: folders.map(f => ({ id: f.id, name: f.name })),
            selected,
            active_server_id: sid,
          },
        });
      } catch (e) {
        console.error('CLI library list failed', e);
        await invoke('cli_publish_library_list', {
          payload: { folders: [], selected: 'all', active_server_id: null },
        }).catch(() => {});
      }
    }).then(u => { u1 = u; });
    listen<string>('cli:library-set', e => {
      const raw = typeof e.payload === 'string' ? e.payload : '';
      if (raw === 'all') useAuthStore.getState().setMusicLibraryFilter('all');
      else if (raw.length > 0) useAuthStore.getState().setMusicLibraryFilter(raw);
    }).then(u => { u2 = u; });
    return () => {
      u1?.();
      u2?.();
    };
  }, []);

  // CLI: servers, search, transport extras, mute, star, rating, play-by-id, reload.
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    listen('cli:server-list', async () => {
      const auth = useAuthStore.getState();
      await invoke('cli_publish_server_list', {
        payload: {
          active_server_id: auth.activeServerId,
          servers: auth.servers.map(s => ({ id: s.id, name: s.name })),
        },
      });
    }).then(u => unsubs.push(u));
    listen<string>('cli:server-set', async e => {
      const raw = typeof e.payload === 'string' ? e.payload : '';
      const id = raw.trim();
      if (!id) return;
      const server = useAuthStore.getState().servers.find(s => s.id === id);
      if (!server) {
        showToast(i18n.t('contextMenu.cliServerNotFound', { defaultValue: 'Server id not found.' }), 4000, 'error');
        return;
      }
      const ok = await switchActiveServer(server);
      if (!ok) {
        showToast(i18n.t('contextMenu.cliServerSwitchFailed', { defaultValue: 'Could not switch server (ping failed).' }), 5000, 'error');
      }
    }).then(u => unsubs.push(u));
    listen<{ scope: string; query: string }>('cli:search', async e => {
      const { scope, query } = e.payload;
      const base = { scope, query, ready: false };
      try {
        const r = await subsonicSearch(query, { songCount: 50, albumCount: 30, artistCount: 30 });
        const payload =
          scope === 'track'
            ? {
                ...base,
                songs: r.songs.map(s => ({ id: s.id, title: s.title, artist: s.artist })),
                albums: [] as { id: string; name: string; artist: string }[],
                artists: [] as { id: string; name: string }[],
                ready: true,
              }
            : scope === 'album'
              ? {
                  ...base,
                  songs: [] as { id: string; title: string; artist: string }[],
                  albums: r.albums.map(a => ({ id: a.id, name: a.name, artist: a.artist })),
                  artists: [] as { id: string; name: string }[],
                  ready: true,
                }
              : {
                  ...base,
                  songs: [] as { id: string; title: string; artist: string }[],
                  albums: [] as { id: string; name: string; artist: string }[],
                  artists: r.artists.map(a => ({ id: a.id, name: a.name })),
                  ready: true,
                };
        await invoke('cli_publish_search_results', { payload });
      } catch (err) {
        console.error('CLI search failed', err);
        await invoke('cli_publish_search_results', {
          payload: {
            ...base,
            songs: [],
            albums: [],
            artists: [],
            ready: true,
            error: err instanceof Error ? err.message : 'search failed',
          },
        }).catch(() => {});
      }
    }).then(u => unsubs.push(u));
    listen<any>('cli:player-command', async e => {
      await executeCliPlayerCommand({ payload: e.payload ?? {}, navigate });
    }).then(u => unsubs.push(u));
    return () => {
      unsubs.forEach(u => u());
    };
  }, []);

  // Sync tray-icon visibility with the user's stored setting.
  // Runs once on mount (initial sync) and again whenever the setting changes.
  const showTrayIcon = useAuthStore(s => s.showTrayIcon);
  useEffect(() => {
    invoke('toggle_tray_icon', { show: showTrayIcon }).catch(console.error);
  }, [showTrayIcon]);

  // Configurable keybindings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const tag = el?.tagName;
      const editable = Boolean(el?.isContentEditable);
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || editable) return;

      const chord = buildInAppBinding(e);
      if (chord) {
        const registered = Object.values(useGlobalShortcutsStore.getState().shortcuts);
        if (registered.includes(chord)) return;
      }

      const { bindings } = useKeybindingsStore.getState();
      const action = matchInAppShortcutAction(e, { ...DEFAULT_IN_APP_BINDINGS, ...bindings });

      if (!action) return;
      e.preventDefault();
      executeRuntimeAction(action, { navigate, previewPolicy: 'stop' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];

    const setup = async () => {
      const handlers: Array<[string, () => void]> = [
        // Hardware media controls should not interrupt active preview playback.
        ['media:play-pause', () => executeRuntimeAction('play-pause', { navigate, previewPolicy: 'ignore' })],
        ['media:play',       () => executeRuntimeAction('play', { navigate, previewPolicy: 'ignore' })],
        ['media:pause',      () => executeRuntimeAction('pause', { navigate, previewPolicy: 'ignore' })],
        ['media:next',       () => executeRuntimeAction('next', { navigate, previewPolicy: 'ignore' })],
        ['media:prev',       () => executeRuntimeAction('prev', { navigate, previewPolicy: 'ignore' })],
        ['media:stop',       () => executeRuntimeAction('stop', { navigate, previewPolicy: 'ignore' })],
        ['media:volume-up',  () => executeRuntimeAction('volume-up', { navigate, previewPolicy: 'ignore' })],
        ['media:volume-down', () => executeRuntimeAction('volume-down', { navigate, previewPolicy: 'ignore' })],
        // Tray clicks are explicit UI intent: stop preview first, then act.
        ['tray:play-pause',  () => executeRuntimeAction('play-pause', { navigate, previewPolicy: 'stop' })],
        ['tray:next',        () => executeRuntimeAction('next', { navigate, previewPolicy: 'stop' })],
        ['tray:previous',    () => executeRuntimeAction('prev', { navigate, previewPolicy: 'stop' })],
      ];
      for (const [event, handler] of handlers) {
        const u = await listen(event, handler);
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }

      {
        const u = await listen<string>('shortcut:global-action', e => {
          const action = e.payload;
          if (!isGlobalShortcutActionId(action)) return;
          executeRuntimeAction(action, { navigate, previewPolicy: 'ignore' });
        });
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }

      {
        const u = await listen<{ action: string; source?: string }>('shortcut:run-action', e => {
          const action = e.payload?.action;
          const source = e.payload?.source;
          if (!action || !isShortcutAction(action)) return;
          if (source === 'mini-window' && !canRunShortcutActionInMiniWindow(action)) return;
          const previewPolicy = source === 'cli' ? 'ignore' : 'stop';
          executeRuntimeAction(action, { navigate, previewPolicy });
        });
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }


      // Seek events carry a numeric payload (seconds) — seek() expects 0-1 progress
      {
        const u = await listen<number>('media:seek-relative', e => {
          const s = usePlayerStore.getState();
          const p = getPlaybackProgressSnapshot();
          const dur = s.currentTrack?.duration;
          if (!dur) return;
          s.seek(Math.max(0, p.currentTime + e.payload) / dur);
        });
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }
      {
        const u = await listen<number>('media:seek-absolute', e => {
          const s = usePlayerStore.getState();
          const dur = s.currentTrack?.duration;
          if (!dur) return;
          s.seek(e.payload / dur);
        });
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }
      {
        const u = await listen<number>('media:set-volume', e => {
          const p = e.payload;
          if (typeof p !== 'number' || Number.isNaN(p)) return;
          usePlayerStore.getState().setVolume(Math.min(1, Math.max(0, p / 100)));
        });
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }

      // Shared exit path: flush play-queue position so other devices can
      // resume from where we left off, tear down any active Orbit session,
      // then ask Rust to exit. Each step is capped at 1500 ms so a slow
      // server can't keep the app hanging on quit; the playback heartbeat
      // is the safety net for anything that didn't make it out in time.
      const performExit = async () => {
        await Promise.race([
          flushPlayQueuePosition(),
          new Promise(r => setTimeout(r, 1500)),
        ]);
        const role = useOrbitStore.getState().role;
        if (role === 'host' || role === 'guest') {
          const teardown = role === 'host' ? endOrbitSession() : leaveOrbitSession();
          await Promise.race([
            teardown.catch(() => {}),
            new Promise(r => setTimeout(r, 1500)),
          ]);
        }
        await invoke('exit_app');
      };

      // window:close-requested is emitted by Rust (prevent_close + emit) on
      // the X-button. JS decides: minimize to tray or exit.
      const u = await listen('window:close-requested', async () => {
        if (useAuthStore.getState().minimizeToTray) {
          await invoke('pause_rendering').catch(() => {});
          await getCurrentWindow().hide();
        } else {
          await performExit();
        }
      });
      if (cancelled) { u(); return; }
      unlisten.push(u);

      // app:force-quit bypasses the minimize-to-tray decision — used by the
      // tray "Exit" menu item and the macOS red close button.
      const fq = await listen('app:force-quit', async () => {
        await performExit();
      });
      if (cancelled) { fq(); return; }
      unlisten.push(fq);
    };

    setup();
    return () => { cancelled = true; unlisten.forEach(u => u()); };
  }, [navigate]);

  // `psysonic --info`: JSON snapshot under XDG_RUNTIME_DIR (Rust writes atomically).
  useEffect(() => {
    let tid: ReturnType<typeof setTimeout> | undefined;
    let lastPublishAt = 0;
    let lastStableKey = '';
    let lastPlaying = false;
    const SNAPSHOT_PLAYING_HEARTBEAT_MS = 4000;
    const SNAPSHOT_IDLE_HEARTBEAT_MS = 15000;
    const publish = () => {
      const s = usePlayerStore.getState();
      const auth = useAuthStore.getState();
      const sid = auth.activeServerId;
      const selected = sid ? (auth.musicLibraryFilterByServer[sid] ?? 'all') : 'all';
      const ct = s.currentTrack;
      const currentTrackUserRating =
        ct != null ? (s.userRatingOverrides[ct.id] ?? ct.userRating ?? null) : null;
      const currentTrackStarred =
        ct != null
          ? (ct.id in s.starredOverrides ? s.starredOverrides[ct.id] : Boolean(ct.starred))
          : null;
      const snapshot = {
        current_track: s.currentTrack,
        current_radio: s.currentRadio,
        queue: s.queue,
        queue_index: s.queueIndex,
        queue_length: s.queue.length,
        is_playing: s.isPlaying,
        current_time: getPlaybackProgressSnapshot().currentTime,
        volume: s.volume,
        repeat_mode: s.repeatMode,
        current_track_user_rating: currentTrackUserRating,
        current_track_starred: currentTrackStarred,
        servers: auth.servers.map(({ id, name }) => ({ id, name })),
        music_library: {
          active_server_id: sid,
          selected,
          folders: auth.musicFolders.map(f => ({ id: f.id, name: f.name })),
        },
      };
      const stableKey = JSON.stringify({
        trackId: s.currentTrack?.id ?? null,
        radioId: s.currentRadio?.id ?? null,
        queueIndex: s.queueIndex,
        queueLength: s.queue.length,
        isPlaying: s.isPlaying,
        volume: Math.round(s.volume * 100),
        repeatMode: s.repeatMode,
        serverId: sid ?? null,
        selected,
        currentTrackUserRating,
        currentTrackStarred,
      });
      const now = Date.now();
      const heartbeatMs = s.isPlaying ? SNAPSHOT_PLAYING_HEARTBEAT_MS : SNAPSHOT_IDLE_HEARTBEAT_MS;
      const stableChanged = stableKey !== lastStableKey;
      const playingEdge = s.isPlaying !== lastPlaying;
      if (!stableChanged && !playingEdge && now - lastPublishAt < heartbeatMs) return;
      lastStableKey = stableKey;
      lastPlaying = s.isPlaying;
      lastPublishAt = now;
      invoke('cli_publish_player_snapshot', { snapshot }).catch(() => {});
    };
    publish();
    const schedule = () => {
      if (tid !== undefined) return;
      tid = setTimeout(() => {
        tid = undefined;
        publish();
      }, 200);
    };
    const unsubP = usePlayerStore.subscribe(schedule);
    const unsubA = useAuthStore.subscribe(schedule);
    return () => {
      unsubP();
      unsubA();
      if (tid !== undefined) clearTimeout(tid);
    };
  }, []);

  return null;
}

export default function App() {
  // Re-subscribe so themeStore changes trigger a re-render (the value itself
  // is consumed via useThemeScheduler / data-theme attribute below).
  useThemeStore(s => s.theme);
  const effectiveTheme = useThemeScheduler();
  const font = useFontStore(s => s.font);

  // Document-attribute hooks are shared between both window kinds — each
  // webview has its own `document`, and theme / font / track-preview tokens
  // are read by CSS in both trees.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', effectiveTheme);
  }, [effectiveTheme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-font', font);
  }, [font]);

  // Hide all inline track-preview buttons when the user opts out — single
  // CSS hook (`html[data-track-previews="off"]`) instead of conditional
  // rendering in every tracklist. Per-location toggles use additional
  // attributes `data-track-previews-{location}` consumed by scoped selectors.
  const trackPreviewsEnabled = useAuthStore(s => s.trackPreviewsEnabled);
  const trackPreviewLocations = useAuthStore(s => s.trackPreviewLocations);
  const trackPreviewDurationSec = useAuthStore(s => s.trackPreviewDurationSec);
  useEffect(() => {
    document.documentElement.setAttribute(
      'data-track-previews',
      trackPreviewsEnabled ? 'on' : 'off',
    );
  }, [trackPreviewsEnabled]);
  useEffect(() => {
    const root = document.documentElement;
    (Object.keys(trackPreviewLocations) as Array<keyof typeof trackPreviewLocations>).forEach(loc => {
      root.setAttribute(`data-track-previews-${loc.toLowerCase()}`, trackPreviewLocations[loc] ? 'on' : 'off');
    });
  }, [trackPreviewLocations]);
  // Drive the SVG progress-ring keyframe duration from the same setting that
  // governs the engine's auto-stop timer so both finish in lockstep.
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--preview-duration',
      `${trackPreviewDurationSec}s`,
    );
  }, [trackPreviewDurationSec]);

  return getWindowKind() === 'mini' ? <MiniPlayerApp /> : <MainApp />;
}
