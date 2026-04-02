import React, { useEffect, useState, useCallback, useRef } from 'react';
import { showToast } from './utils/toast';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PanelRight, PanelRightClose } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Sidebar from './components/Sidebar';
import PlayerBar from './components/PlayerBar';
import LiveSearch from './components/LiveSearch';
import NowPlayingDropdown from './components/NowPlayingDropdown';
import QueuePanel from './components/QueuePanel';
import Home from './pages/Home';
import Albums from './pages/Albums';
import Artists from './pages/Artists';
import ArtistDetail from './pages/ArtistDetail';
import NewReleases from './pages/NewReleases';
import Favorites from './pages/Favorites';
import RandomMix from './pages/RandomMix';
import Settings from './pages/Settings';
import Login from './pages/Login';
import AlbumDetail from './pages/AlbumDetail';
import LabelAlbums from './pages/LabelAlbums';
import Statistics from './pages/Statistics';
import Help from './pages/Help';
import RandomAlbums from './pages/RandomAlbums';
import SearchResults from './pages/SearchResults';
import AdvancedSearch from './pages/AdvancedSearch';
import Playlists from './pages/Playlists';
import PlaylistDetail from './pages/PlaylistDetail';
import NowPlayingPage from './pages/NowPlaying';
import FullscreenPlayer from './components/FullscreenPlayer';
import ContextMenu from './components/ContextMenu';
import SongInfoModal from './components/SongInfoModal';
import DownloadFolderModal from './components/DownloadFolderModal';
import { DragDropProvider } from './contexts/DragDropContext';
import TooltipPortal from './components/TooltipPortal';
import ConnectionIndicator from './components/ConnectionIndicator';
import LastfmIndicator from './components/LastfmIndicator';
import OfflineOverlay from './components/OfflineOverlay';
import OfflineBanner from './components/OfflineBanner';
import OfflineLibrary from './pages/OfflineLibrary';
import Genres from './pages/Genres';
import GenreDetail from './pages/GenreDetail';
import ExportPickerModal from './components/ExportPickerModal';
import ChangelogModal from './components/ChangelogModal';
import AppUpdater from './components/AppUpdater';
import { version } from '../package.json';
import { useConnectionStatus } from './hooks/useConnectionStatus';
import { useAuthStore } from './store/authStore';
import { useOfflineStore } from './store/offlineStore';
import { usePlayerStore, initAudioListeners } from './store/playerStore';
import { useThemeStore } from './store/themeStore';
import { useFontStore } from './store/fontStore';
import { useEqStore } from './store/eqStore';
import { useKeybindingsStore } from './store/keybindingsStore';
import { useGlobalShortcutsStore } from './store/globalShortcutsStore';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isLoggedIn, servers, activeServerId } = useAuthStore();
  if (!isLoggedIn || !activeServerId || servers.length === 0) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppShell() {
  const { t } = useTranslation();
  const isFullscreenOpen = usePlayerStore(s => s.isFullscreenOpen);
  const toggleFullscreen = usePlayerStore(s => s.toggleFullscreen);
  const isQueueVisible = usePlayerStore(s => s.isQueueVisible);
  const toggleQueue = usePlayerStore(s => s.toggleQueue);
  const initializeFromServerQueue = usePlayerStore(s => s.initializeFromServerQueue);
  const currentTrack = usePlayerStore(s => s.currentTrack);
  const isPlaying = usePlayerStore(s => s.isPlaying);
  const { status: connStatus, isRetrying: connRetrying, retry: connRetry, isLan, serverName } = useConnectionStatus();
  const navigate = useNavigate();
  const location = useLocation();
  const serverId = useAuthStore(s => s.activeServerId ?? '');
  const offlineAlbums = useOfflineStore(s => s.albums);
  const hasOfflineContent = Object.values(offlineAlbums).some(a => a.serverId === serverId);

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

  const [changelogModalOpen, setChangelogModalOpen] = useState(false);

  useEffect(() => {
    const { showChangelogOnUpdate, lastSeenChangelogVersion } = useAuthStore.getState();
    if (showChangelogOnUpdate && lastSeenChangelogVersion !== version) {
      setChangelogModalOpen(true);
    }
  }, []);

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
      const newWidth = Math.max(250, Math.min(window.innerWidth - e.clientX, 500));
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

    document.addEventListener('dragover', allow);
    document.addEventListener('dragenter', allow);
    document.addEventListener('drop', blockDrop);

    return () => {
      document.removeEventListener('dragover', allow);
      document.removeEventListener('dragenter', allow);
      document.removeEventListener('drop', blockDrop);
    };
  }, []);

  return (
    <div 
      className="app-shell"
      style={{
        '--sidebar-width': isSidebarCollapsed ? '72px' : 'clamp(200px, 15vw, 220px)',
        '--queue-width': isQueueVisible ? `${queueWidth}px` : '0px'
      } as React.CSSProperties}
      onContextMenu={e => e.preventDefault()}
    >
      <Sidebar
        isCollapsed={isSidebarCollapsed}
        toggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
      />
      <main className="main-content">
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
        {connStatus === 'disconnected' && hasOfflineContent && (
          <OfflineBanner onRetry={connRetry} isChecking={connRetrying} />
        )}
        <div className="content-body" style={{ padding: 0, position: 'relative' }}>
          {connStatus === 'disconnected' && !hasOfflineContent && (
            <OfflineOverlay
              serverName={serverName}
              onRetry={connRetry}
              isChecking={connRetrying}
            />
          )}
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/albums" element={<Albums />} />
            <Route path="/random-albums" element={<RandomAlbums />} />
            <Route path="/album/:id" element={<AlbumDetail />} />
            <Route path="/artists" element={<Artists />} />
            <Route path="/artist/:id" element={<ArtistDetail />} />
            <Route path="/new-releases" element={<NewReleases />} />
            <Route path="/favorites" element={<Favorites />} />
            <Route path="/random-mix" element={<RandomMix />} />
            <Route path="/label/:name" element={<LabelAlbums />} />
            <Route path="/search" element={<SearchResults />} />
            <Route path="/search/advanced" element={<AdvancedSearch />} />
            <Route path="/statistics" element={<Statistics />} />
            <Route path="/now-playing" element={<NowPlayingPage />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/help" element={<Help />} />
            <Route path="/offline" element={<OfflineLibrary />} />
            <Route path="/genres" element={<Genres />} />
            <Route path="/genres/:name" element={<GenreDetail />} />
            <Route path="/playlists" element={<Playlists />} />
            <Route path="/playlists/:id" element={<PlaylistDetail />} />
          </Routes>
        </div>
      </main>
      <div 
        className="resizer resizer-queue" 
        onMouseDown={(e) => {
          e.preventDefault();
          setIsDraggingQueue(true);
        }}
        style={{ display: isQueueVisible ? 'block' : 'none' }}
      />
      <QueuePanel />
      <PlayerBar />
      {isFullscreenOpen && (
        <FullscreenPlayer onClose={toggleFullscreen} />
      )}
      <ContextMenu />
      <SongInfoModal />
      <DownloadFolderModal />
      <TooltipPortal />
      <AppUpdater />
      {changelogModalOpen && <ChangelogModal onClose={() => setChangelogModalOpen(false)} />}
    </div>
  );
}

// Media key + tray event handler
function TauriEventBridge() {
  const togglePlay = usePlayerStore(s => s.togglePlay);
  const next = usePlayerStore(s => s.next);
  const previous = usePlayerStore(s => s.previous);

  // Configurable keybindings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // Global shortcuts use modifier combos — skip in-app bindings for those
      // (X11 GrabModeAsync delivers the key to both the grabber and the focused WebView)
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      const { bindings } = useKeybindingsStore.getState();
      const { togglePlay, next, previous, setVolume, seek, toggleQueue, toggleFullscreen } = usePlayerStore.getState();

      const action = (Object.entries(bindings) as [string, string | null][])
        .find(([, code]) => code === e.code)?.[0];

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
          seek(Math.min(s.currentTrack?.duration ?? 0, s.currentTime + 10));
          break;
        }
        case 'seek-backward': {
          const s = usePlayerStore.getState();
          seek(Math.max(0, s.currentTime - 10));
          break;
        }
        case 'toggle-queue':      toggleQueue(); break;
        case 'fullscreen-player': toggleFullscreen(); break;
        case 'native-fullscreen': {
          const win = getCurrentWindow();
          win.isFullscreen().then(fs => win.setFullscreen(!fs));
          break;
        }
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
        ['media:next',        () => next()],
        ['media:prev',        () => previous()],
        ['tray:play-pause',   () => togglePlay()],
        ['tray:next',         () => next()],
        ['tray:previous',     () => previous()],
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

  return null;
}

export default function App() {
  const theme = useThemeStore(s => s.theme);
  const font = useFontStore(s => s.font);
  const [exportPickerOpen, setExportPickerOpen] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-font', font);
  }, [font]);

  useEffect(() => {
    return initAudioListeners();
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
    </BrowserRouter>
  );
}
