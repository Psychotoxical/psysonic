import React, { useEffect, useState, useCallback, useRef, lazy, Suspense } from 'react';
import { showToast } from './utils/toast';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PanelRight, PanelRightClose } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Sidebar from './components/Sidebar';
import PlayerBar from './components/PlayerBar';
import BottomNav from './components/BottomNav';
import MobilePlayerView from './components/MobilePlayerView';
import { useIsMobile } from './hooks/useIsMobile';
import LiveSearch from './components/LiveSearch';
import NowPlayingDropdown from './components/NowPlayingDropdown';
import QueuePanel from './components/QueuePanel';
// Eager — main browsing flow, loaded on first paint
import Home from './pages/Home';
import Albums from './pages/Albums';
import Artists from './pages/Artists';
import ArtistDetail from './pages/ArtistDetail';
import NewReleases from './pages/NewReleases';
import Favorites from './pages/Favorites';
import RandomMix from './pages/RandomMix';
import RandomLanding from './pages/RandomLanding';
import Login from './pages/Login';
import AlbumDetail from './pages/AlbumDetail';
import MostPlayed from './pages/MostPlayed';
import RandomAlbums from './pages/RandomAlbums';
import SearchResults from './pages/SearchResults';
import Playlists from './pages/Playlists';
import PlaylistDetail from './pages/PlaylistDetail';
import NowPlayingPage from './pages/NowPlaying';

// Lazy — visited rarely or on-demand. Each becomes its own chunk so the
// initial bundle stays smaller and these pages don't block first paint.
const Settings       = lazy(() => import('./pages/Settings'));
const Statistics     = lazy(() => import('./pages/Statistics'));
const Help           = lazy(() => import('./pages/Help'));
const WhatsNew       = lazy(() => import('./pages/WhatsNew'));
const DeviceSync     = lazy(() => import('./pages/DeviceSync'));
const OfflineLibrary = lazy(() => import('./pages/OfflineLibrary'));
const LabelAlbums    = lazy(() => import('./pages/LabelAlbums'));
const AdvancedSearch = lazy(() => import('./pages/AdvancedSearch'));
const FolderBrowser  = lazy(() => import('./pages/FolderBrowser'));
const InternetRadio  = lazy(() => import('./pages/InternetRadio'));
import MiniPlayer from './components/MiniPlayer';
import { initMiniPlayerBridgeOnMain } from './utils/miniPlayerBridge';
import FullscreenPlayer from './components/FullscreenPlayer';
import ContextMenu from './components/ContextMenu';
import SongInfoModal from './components/SongInfoModal';
import DownloadFolderModal from './components/DownloadFolderModal';
import { DragDropProvider } from './contexts/DragDropContext';
import TooltipPortal from './components/TooltipPortal';
import OverlayScrollArea from './components/OverlayScrollArea';
import { APP_MAIN_SCROLL_VIEWPORT_ID } from './constants/appScroll';
import ConnectionIndicator from './components/ConnectionIndicator';
import LastfmIndicator from './components/LastfmIndicator';
import OfflineBanner from './components/OfflineBanner';
import Genres from './pages/Genres';
import GenreDetail from './pages/GenreDetail';
import ExportPickerModal from './components/ExportPickerModal';
import AppUpdater from './components/AppUpdater';
import TitleBar from './components/TitleBar';
import { IS_LINUX, IS_MACOS, IS_WINDOWS } from './utils/platform';
import { version } from '../package.json';
import { useConnectionStatus } from './hooks/useConnectionStatus';
import { useAuthStore } from './store/authStore';
import {
  getMusicFolders,
  getSimilarSongs,
  getSong,
  probeEntityRatingSupport,
  search as subsonicSearch,
  setRating,
  star,
  unstar,
} from './api/subsonic';
import { useOfflineStore } from './store/offlineStore';
import { initHotCachePrefetch } from './hotCachePrefetch';
import i18n from './i18n';
import { playByOpaqueId } from './utils/playByOpaqueId';
import { switchActiveServer } from './utils/switchActiveServer';
import { usePlayerStore, initAudioListeners, songToTrack, shuffleArray } from './store/playerStore';
import { useThemeStore } from './store/themeStore';
import { useThemeScheduler } from './hooks/useThemeScheduler';
import { useFontStore } from './store/fontStore';
import { useEqStore } from './store/eqStore';
import { useKeybindingsStore, matchInAppBinding, buildInAppBinding } from './store/keybindingsStore';
import { useGlobalShortcutsStore } from './store/globalShortcutsStore';
import { useZipDownloadStore } from './store/zipDownloadStore';
import ZipDownloadOverlay from './components/ZipDownloadOverlay';

/** Volume before last `psysonic --player mute` (CLI only; in-memory). */
let cliPremuteVolume: number | null = null;

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isLoggedIn, servers, activeServerId } = useAuthStore();
  if (!isLoggedIn || !activeServerId || servers.length === 0) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/**
 * Avoid grabbing the queue resizer when aiming at the main overlay scrollbar.
 * Uses the real main viewport edge (not innerWidth − queueWidth — sidebar/zoom skew that).
 * Only the main-route thumb counts (not queue/mini thumbs, which share the same class).
 */
function shouldSuppressQueueResizerMouseDown(clientX: number, clientY: number, queueWidth: number): boolean {
  const vp = document.getElementById(APP_MAIN_SCROLL_VIEWPORT_ID) as HTMLElement | null;
  const mainRight = vp ? vp.getBoundingClientRect().right : window.innerWidth - queueWidth;
  if (clientX <= mainRight) return true;

  const thumbs = document.querySelectorAll<HTMLElement>('.app-shell-route-scroll .overlay-scroll__thumb');
  const xSlop = 22;
  const vPad = 40;
  for (let i = 0; i < thumbs.length; i++) {
    const r = thumbs[i].getBoundingClientRect();
    if (r.height < 4 || r.width < 1) continue;
    if (clientY < r.top - vPad || clientY > r.bottom + vPad) continue;
    if (clientX >= r.left - 6 && clientX <= r.right + xSlop) return true;
  }
  return false;
}

function AppShell() {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(false);
  const [isTilingWm, setIsTilingWm] = useState(false);

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
        } else {
          document.title = 'Psysonic';
          await appWindow.setTitle('Psysonic');
        }
      } catch (err) {}
    };
    fn();
  }, [currentTrack, isPlaying]);

  // Post-update changelog is now surfaced via a dismissible banner in the
  // sidebar (WhatsNewBanner) that links to the /whats-new page — no auto
  // modal takeover on startup.

  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    return localStorage.getItem('psysonic_sidebar_collapsed') === 'true';
  });
  const [queueWidth, setQueueWidth] = useState(340);
  const [isDraggingQueue, setIsDraggingQueue] = useState(false);

  useEffect(() => {
    localStorage.setItem('psysonic_sidebar_collapsed', isSidebarCollapsed.toString());
  }, [isSidebarCollapsed]);

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

  // ── Global DnD fix for Linux/WebKitGTK ──────────────────────────
  // WebKitGTK (used by Tauri on Linux) requires the document itself to
  // accept drags via preventDefault() on dragover/dragenter.  Without
  // this, the webview shows a "forbidden" cursor for all in-app HTML5
  // drag-and-drop because it never sees a valid drop target at the
  // document level.  This is harmless on Windows/macOS where DnD already
  // works correctly.
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

    document.addEventListener('dragover', allow);
    document.addEventListener('dragenter', allow);
    document.addEventListener('drop', blockDrop);
    document.addEventListener('keydown', blockSelectAll, true);
    document.addEventListener('selectstart', blockSelectStart);

    return () => {
      document.removeEventListener('dragover', allow);
      document.removeEventListener('dragenter', allow);
      document.removeEventListener('drop', blockDrop);
      document.removeEventListener('keydown', blockSelectAll, true);
      document.removeEventListener('selectstart', blockSelectStart);
    };
  }, []);

  // Pause CSS animations when the window is minimized / hidden.
  // WebView2 on Windows keeps compositing infinite-loop animations (mesh-aura,
  // portrait-drift, eq-bounce, …) even when the app is minimized, which shows
  // up as steady GPU usage. The CSS rule `html[data-app-hidden="true"]` in
  // components.css pauses all running animations while this flag is set.
  useEffect(() => {
    const update = () => {
      document.documentElement.dataset.appHidden = document.hidden ? 'true' : 'false';
    };
    document.addEventListener('visibilitychange', update);
    update();
    return () => document.removeEventListener('visibilitychange', update);
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
        '--queue-width': isMobile ? '0px' : (isQueueVisible ? `${queueWidth}px` : '0px')
      } as React.CSSProperties}
      onContextMenu={e => e.preventDefault()}
    >
      {IS_LINUX && useCustomTitlebar && !isWindowFullscreen && !isTilingWm && <TitleBar />}
      {!isMobile && (
        <Sidebar
          isCollapsed={isSidebarCollapsed}
          toggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
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
          <button
            className="queue-toggle-btn"
            onClick={toggleQueue}
            data-tooltip={t('player.toggleQueue')}
            data-tooltip-pos="bottom"
          >
            {isQueueVisible ? <PanelRightClose size={18} /> : <PanelRight size={18} />}
          </button>
        </header>
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
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/albums" element={<Albums />} />
                <Route path="/random" element={<RandomLanding />} />
                <Route path="/random/albums" element={<RandomAlbums />} />
                <Route path="/album/:id" element={<AlbumDetail />} />
                <Route path="/artists" element={<Artists />} />
                <Route path="/artist/:id" element={<ArtistDetail />} />
                <Route path="/new-releases" element={<NewReleases />} />
                <Route path="/favorites" element={<Favorites />} />
                <Route path="/random/mix" element={<RandomMix />} />
                <Route path="/label/:name" element={<LabelAlbums />} />
                <Route path="/search" element={<SearchResults />} />
                <Route path="/search/advanced" element={<AdvancedSearch />} />
                <Route path="/statistics" element={<Statistics />} />
                <Route path="/most-played" element={<MostPlayed />} />
                <Route path="/now-playing" element={isMobile ? <MobilePlayerView /> : <NowPlayingPage />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/whats-new" element={<WhatsNew />} />
                <Route path="/help" element={<Help />} />
                <Route path="/offline" element={<OfflineLibrary />} />
                <Route path="/genres" element={<Genres />} />
                <Route path="/genres/:name" element={<GenreDetail />} />
                <Route path="/playlists" element={<Playlists />} />
                <Route path="/playlists/:id" element={<PlaylistDetail />} />
                <Route path="/radio" element={<InternetRadio />} />
                <Route path="/folders" element={<FolderBrowser />} />
                <Route path="/device-sync" element={<DeviceSync />} />
              </Routes>
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
            if (document.body.classList.contains('is-overlay-scrollbar-thumb-drag')) return;
            if (shouldSuppressQueueResizerMouseDown(e.clientX, e.clientY, queueWidth)) return;
            setIsDraggingQueue(true);
          }}
          style={{ display: isQueueVisible ? 'block' : 'none' }}
        />
      )}
      {!isMobile && <QueuePanel />}
      {isMobile && !isMobilePlayer && <BottomNav />}
      {!isMobilePlayer && <PlayerBar />}
      {isFullscreenOpen && (
        <FullscreenPlayer onClose={toggleFullscreen} />
      )}
      <ContextMenu />
      <SongInfoModal />
      <DownloadFolderModal />
      <TooltipPortal />
      <AppUpdater />
    </div>
  );
}

// Media key + tray event handler
function TauriEventBridge() {
  const navigate = useNavigate();
  const togglePlay = usePlayerStore(s => s.togglePlay);
  const next = usePlayerStore(s => s.next);
  const previous = usePlayerStore(s => s.previous);

  // ZIP download progress events from Rust
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ id: string; bytes: number; total: number | null }>('download:zip:progress', e => {
      useZipDownloadStore.getState().updateProgress(e.payload.id, e.payload.bytes, e.payload.total);
    }).then(u => { unlisten = u; });
    return () => { unlisten?.(); };
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
    listen<string>('cli:play-id', async e => {
      const id = typeof e.payload === 'string' ? e.payload.trim() : '';
      if (!id) return;
      try {
        await playByOpaqueId(id);
      } catch (err) {
        console.error('CLI play failed', err);
        const notFound = err instanceof Error && err.message === 'play_by_id_not_found';
        showToast(
          i18n.t('contextMenu.cliPlayIdNotFound', {
            defaultValue: notFound
              ? 'No song, album, or artist matches this id.'
              : 'Could not start playback.',
          }),
          5000,
          'error',
        );
      }
    }).then(u => unsubs.push(u));
    listen('cli:shuffle-queue', () => {
      usePlayerStore.getState().shuffleQueue();
    }).then(u => unsubs.push(u));
    listen<string>('cli:set-repeat', e => {
      const m = typeof e.payload === 'string' ? e.payload : '';
      const mode = m === 'all' ? 'all' : m === 'one' ? 'one' : 'off';
      usePlayerStore.setState({ repeatMode: mode });
    }).then(u => unsubs.push(u));
    listen('cli:mute', () => {
      const { volume, setVolume } = usePlayerStore.getState();
      if (volume > 0) cliPremuteVolume = volume;
      setVolume(0);
    }).then(u => unsubs.push(u));
    listen('cli:unmute', () => {
      const restore = cliPremuteVolume ?? 0.8;
      cliPremuteVolume = null;
      usePlayerStore.getState().setVolume(restore);
    }).then(u => unsubs.push(u));
    listen<boolean>('cli:star-current', async e => {
      const want = e.payload === true;
      const track = usePlayerStore.getState().currentTrack;
      if (!track) {
        showToast(i18n.t('contextMenu.cliMixNeedsTrack'), 5000, 'error');
        return;
      }
      try {
        if (want) {
          await star(track.id, 'song');
          usePlayerStore.getState().setStarredOverride(track.id, true);
        } else {
          await unstar(track.id, 'song');
          usePlayerStore.getState().setStarredOverride(track.id, false);
        }
      } catch (err) {
        console.error('CLI star failed', err);
        showToast(i18n.t('contextMenu.cliStarFailed', { defaultValue: 'Star/unstar failed.' }), 5000, 'error');
      }
    }).then(u => unsubs.push(u));
    listen<number>('cli:set-rating-current', async e => {
      const stars = e.payload;
      if (typeof stars !== 'number' || Number.isNaN(stars) || stars < 0 || stars > 5) return;
      const track = usePlayerStore.getState().currentTrack;
      if (!track) {
        showToast(i18n.t('contextMenu.cliMixNeedsTrack'), 5000, 'error');
        return;
      }
      try {
        await setRating(track.id, stars);
        usePlayerStore.getState().setUserRatingOverride(track.id, stars);
      } catch (err) {
        console.error('CLI set rating failed', err);
      }
    }).then(u => unsubs.push(u));
    listen('cli:reload-player', async () => {
      const store = usePlayerStore.getState();
      const { currentTrack, queue, stop, resetAudioPause, playTrack, initializeFromServerQueue } = store;
      stop();
      resetAudioPause();
      await invoke('audio_stop').catch(() => {});
      if (currentTrack) {
        try {
          const fresh = await getSong(currentTrack.id);
          const t = fresh ? songToTrack(fresh) : currentTrack;
          playTrack(t, queue, true);
        } catch {
          playTrack(currentTrack, queue, true);
        }
      } else {
        await initializeFromServerQueue();
      }
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
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const chord = buildInAppBinding(e);
      if (chord) {
        const registered = Object.values(useGlobalShortcutsStore.getState().shortcuts);
        if (registered.includes(chord)) return;
      }

      const { bindings } = useKeybindingsStore.getState();
      const { togglePlay, next, previous, setVolume, seek, toggleQueue, toggleFullscreen } = usePlayerStore.getState();

      const action = (Object.entries(bindings) as [string, string | null][])
        .find(([, b]) => matchInAppBinding(e, b))?.[0];

      if (!action) return;
      e.preventDefault();

      switch (action) {
        case 'play-pause':        togglePlay(); break;
        case 'next':              next(); break;
        case 'prev':              previous(); break;
        case 'volume-up':         setVolume(Math.min(1, usePlayerStore.getState().volume + 0.05)); break;
        case 'volume-down':       setVolume(Math.max(0, usePlayerStore.getState().volume - 0.05)); break;
        case 'seek-forward': {
          const s = usePlayerStore.getState();
          const dur = s.currentTrack?.duration ?? 0;
          if (!dur) break;
          seek(Math.min(1, (s.currentTime + 10) / dur));
          break;
        }
        case 'seek-backward': {
          const s = usePlayerStore.getState();
          const dur = s.currentTrack?.duration ?? 0;
          if (!dur) break;
          seek(Math.max(0, (s.currentTime - 10) / dur));
          break;
        }
        case 'toggle-queue':      toggleQueue(); break;
        case 'open-folder-browser':
          navigate('/folders', { state: { folderBrowserRevealTs: Date.now() } });
          break;
        case 'fullscreen-player': toggleFullscreen(); break;
        case 'native-fullscreen': {
          const win = getCurrentWindow();
          win.isFullscreen().then(fs => win.setFullscreen(!fs));
          break;
        }
        case 'open-mini-player':
          invoke('open_mini_player').catch(() => {});
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];

    const setup = async () => {
      const handlers: Array<[string, () => void]> = [
        ['media:play-pause',  () => togglePlay()],
        ['media:play',        () => { const s = usePlayerStore.getState(); if (!s.isPlaying) s.resume(); }],
        ['media:pause',       () => { const s = usePlayerStore.getState(); if (s.isPlaying) s.pause(); }],
        ['media:next',        () => next()],
        ['media:prev',        () => previous()],
        ['tray:play-pause',   () => togglePlay()],
        ['tray:next',         () => next()],
        ['tray:previous',     () => previous()],
        ['media:stop',        () => usePlayerStore.getState().stop()],
        ['media:volume-up',   () => { const s = usePlayerStore.getState(); s.setVolume(Math.min(1, s.volume + 0.05)); }],
        ['media:volume-down', () => { const s = usePlayerStore.getState(); s.setVolume(Math.max(0, s.volume - 0.05)); }],
      ];
      for (const [event, handler] of handlers) {
        const u = await listen(event, handler);
        if (cancelled) { u(); return; }
        unlisten.push(u);
      }

      // Seek events carry a numeric payload (seconds) — seek() expects 0-1 progress
      {
        const u = await listen<number>('media:seek-relative', e => {
          const s = usePlayerStore.getState();
          const dur = s.currentTrack?.duration;
          if (!dur) return;
          s.seek(Math.max(0, s.currentTime + e.payload) / dur);
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

      // window:close-requested is emitted by Rust (prevent_close + emit).
      // JS decides: minimize to tray or exit, based on user setting.
      const u = await listen('window:close-requested', async () => {
        if (useAuthStore.getState().minimizeToTray) {
          await getCurrentWindow().hide();
        } else {
          await invoke('exit_app');
        }
      });
      if (cancelled) { u(); return; }
      unlisten.push(u);
    };

    setup();
    return () => { cancelled = true; unlisten.forEach(u => u()); };
  }, [togglePlay, next, previous]);

  // `psysonic --info`: JSON snapshot under XDG_RUNTIME_DIR (Rust writes atomically).
  useEffect(() => {
    let tid: ReturnType<typeof setTimeout> | undefined;
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
        current_time: s.currentTime,
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
      invoke('cli_publish_player_snapshot', { snapshot }).catch(() => {});
    };
    publish();
    const schedule = () => {
      if (tid !== undefined) clearTimeout(tid);
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
  useThemeStore(s => s.theme); // keep subscription so re-render on manual change
  const effectiveTheme = useThemeScheduler();
  const font = useFontStore(s => s.font);
  const [exportPickerOpen, setExportPickerOpen] = useState(false);

  // Mini Player window: detected via Tauri window label. Rendered without
  // router / sidebar / full audio listeners — it just listens for state + sends
  // control events. Label is read synchronously from a global set in main.tsx
  // so the initial render picks the right tree.
  const isMiniWindow = typeof window !== 'undefined' && (window as any).__PSY_WINDOW_LABEL__ === 'mini';

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', effectiveTheme);
  }, [effectiveTheme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-font', font);
  }, [font]);

  // Main window only: push playback state to mini window + handle control events.
  useEffect(() => {
    if (isMiniWindow) return;
    return initMiniPlayerBridgeOnMain();
  }, [isMiniWindow]);

  // Main window only: optionally pre-create the mini player webview hidden so
  // the first open is instant. Windows already does this unconditionally in
  // Rust .setup() as a hang workaround — skip here to avoid double-building.
  const preloadMiniPlayer = useAuthStore(s => s.preloadMiniPlayer);
  useEffect(() => {
    if (isMiniWindow || IS_WINDOWS || !preloadMiniPlayer) return;
    invoke('preload_mini_player').catch(() => {});
  }, [isMiniWindow, preloadMiniPlayer]);

  // Mini window only: re-hydrate persisted appearance stores when the main
  // window writes new values. Both webviews share localStorage (same origin),
  // so the `storage` event fires here whenever main mutates a key — but
  // Zustand persist only reads localStorage on initial load, hence the
  // explicit rehydrate.
  useEffect(() => {
    if (!isMiniWindow) return;
    const onStorage = (e: StorageEvent) => {
      if (!e.key) return;
      if (e.key === 'psysonic_theme') useThemeStore.persist.rehydrate();
      else if (e.key === 'psysonic_font') useFontStore.persist.rehydrate();
      else if (e.key === 'psysonic_keybindings') useKeybindingsStore.persist.rehydrate();
      else if (e.key === 'psysonic_language' && e.newValue) {
        import('./i18n').then(m => m.default.changeLanguage(e.newValue!));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [isMiniWindow]);

  if (isMiniWindow) {
    return (
      <DragDropProvider>
        <MiniPlayer />
        <TooltipPortal />
      </DragDropProvider>
    );
  }

  // UI scaling is scoped to .main-content via an inner wrapper (see <main>
  // below). Sidebar, queue, player bar and (Linux) custom title bar stay 1:1
  // because they live in separate grid cells. Document-level zoom is not used
  // — it broke portal positioning and Tauri window measurement.

  useEffect(() => {
    return initAudioListeners();
  }, []);

  useEffect(() => {
    return initHotCachePrefetch();
  }, []);

  useEffect(() => {
    useGlobalShortcutsStore.getState().registerAll();
  }, []);

  // ── Easter egg: Ctrl+Shift+Alt+N → export new albums image ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey || !e.altKey || e.code !== 'KeyN') return;
      e.preventDefault();
      setExportPickerOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleExport = async (since: number) => {
    setExportPickerOpen(false);
    try {
      const { exportNewAlbumsImage } = await import('./utils/exportNewAlbums');
      const result = await exportNewAlbumsImage(since);
      if (result) {
        const files = result.paths.length > 1 ? ` (${result.paths.length} Dateien)` : '';
        showToast(`📸 ${result.count} Alben exportiert${files}`);
      } else {
        showToast('📭 Keine Alben in diesem Zeitraum gefunden');
      }
    } catch (err) {
      showToast(`❌ Export fehlgeschlagen: ${String(err).slice(0, 80)}`);
      console.error('[easter egg] export failed:', err);
    }
  };

  useEffect(() => {
    const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement;
      el.classList.add('is-scrolling');
      const existing = timers.get(el);
      if (existing !== undefined) clearTimeout(existing);
      timers.set(el, setTimeout(() => {
        el.classList.remove('is-scrolling');
        timers.delete(el);
      }, 800));
    };
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('scroll', onScroll, true);
      timers.forEach(t => clearTimeout(t));
    };
  }, []);

  return (
    <BrowserRouter>
      <TauriEventBridge />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/*"
          element={
            <RequireAuth>
              <DragDropProvider>
                <AppShell />
              </DragDropProvider>
            </RequireAuth>
          }
        />
      </Routes>
      {exportPickerOpen && <ExportPickerModal onConfirm={handleExport} onClose={() => setExportPickerOpen(false)} />}
      <ZipDownloadOverlay />
    </BrowserRouter>
  );
}
