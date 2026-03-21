import React, { useEffect, useState, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
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
import Playlists from './pages/Playlists';
import Help from './pages/Help';
import RandomAlbums from './pages/RandomAlbums';
import SearchResults from './pages/SearchResults';
import NowPlayingPage from './pages/NowPlaying';
import FullscreenPlayer from './components/FullscreenPlayer';
import ContextMenu from './components/ContextMenu';
import DownloadFolderModal from './components/DownloadFolderModal';
import TooltipPortal from './components/TooltipPortal';
import ConnectionIndicator from './components/ConnectionIndicator';
import LastfmIndicator from './components/LastfmIndicator';
import OfflineOverlay from './components/OfflineOverlay';
import { useConnectionStatus } from './hooks/useConnectionStatus';
import { useAuthStore } from './store/authStore';
import { usePlayerStore, initAudioListeners } from './store/playerStore';
import { useThemeStore } from './store/themeStore';
import { useFontStore } from './store/fontStore';
import { useEqStore } from './store/eqStore';
import { useKeybindingsStore } from './store/keybindingsStore';

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
            className="collapse-btn"
            onClick={toggleQueue}
            data-tooltip={t('player.toggleQueue')}
            data-tooltip-pos="bottom"
          >
            {isQueueVisible ? <PanelRightClose size={24} /> : <PanelRight size={24} />}
          </button>
        </header>
        <div className="content-body" style={{ padding: 0, position: 'relative' }}>
          {connStatus === 'disconnected' && (
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
            <Route path="/playlists" element={<Playlists />} />
            <Route path="/label/:name" element={<LabelAlbums />} />
            <Route path="/search" element={<SearchResults />} />
            <Route path="/statistics" element={<Statistics />} />
            <Route path="/now-playing" element={<NowPlayingPage />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/help" element={<Help />} />
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
      <DownloadFolderModal />
      <TooltipPortal />
    </div>
  );
}

// Tray / media key event handler
function TauriEventBridge() {
  const togglePlay = usePlayerStore(s => s.togglePlay);
  const next = usePlayerStore(s => s.next);
  const previous = usePlayerStore(s => s.previous);
  const { minimizeToTray } = useAuthStore();

  // Configurable keybindings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

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
    const unlisten: Array<() => void> = [];

    listen('media:play-pause', () => togglePlay()).then(u => unlisten.push(u));
    listen('media:next', () => next()).then(u => unlisten.push(u));
    listen('media:prev', () => previous()).then(u => unlisten.push(u));
    listen('tray:play-pause', () => togglePlay()).then(u => unlisten.push(u));
    listen('tray:next', () => next()).then(u => unlisten.push(u));

    // Handle close → minimize to tray if enabled (Tauri 2 approach)
    const win = getCurrentWindow();
    win.onCloseRequested(async (event) => {
      if (minimizeToTray) {
        event.preventDefault();
        await win.hide();
      } else {
        // If not minimizing to tray, we want to exit the app completely
        await invoke('exit_app');
      }
    }).then(u => unlisten.push(u));

    return () => unlisten.forEach(u => u());
  }, [togglePlay, next, previous, minimizeToTray]);

  return null;
}

export default function App() {
  const theme = useThemeStore(s => s.theme);
  const font = useFontStore(s => s.font);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-font', font);
  }, [font]);

  useEffect(() => {
    return initAudioListeners();
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
              <AppShell />
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
