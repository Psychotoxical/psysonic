import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { showToast } from '../utils/toast';
import { WindowVisibilityProvider } from '../hooks/useWindowVisibility';
import { DragDropProvider } from '../contexts/DragDropContext';
import PasteClipboardHandler from '../components/PasteClipboardHandler';
import ExportPickerModal from '../components/ExportPickerModal';
import ZipDownloadOverlay from '../components/ZipDownloadOverlay';
import FpsOverlay from '../components/FpsOverlay';
import { useAuthStore } from '../store/authStore';
import { useGlobalShortcutsStore } from '../store/globalShortcutsStore';
import { initAudioListeners } from '../store/playerStore';
import { initHotCachePrefetch } from '../hotCachePrefetch';
import { initMiniPlayerBridgeOnMain } from '../utils/miniPlayerBridge';
import { IS_WINDOWS } from '../utils/platform';
import { AppShell, RequireAuth, TauriEventBridge } from '../App';

const Login = lazy(() => import('../pages/Login'));

/**
 * Main webview tree. Hosts the router, the application shell (sidebar /
 * player bar / queue panel / main scroll viewport), the Tauri event bridge,
 * and all background lifecycle hooks (audio listeners, hot-cache prefetch,
 * global shortcuts, mini-player bridge, easter egg, scrollbar auto-hide).
 */
export default function MainApp() {
  const [exportPickerOpen, setExportPickerOpen] = useState(false);

  // Push playback state to mini window + handle control events.
  useEffect(() => {
    return initMiniPlayerBridgeOnMain();
  }, []);

  // Optionally pre-create the mini player webview hidden so the first open
  // is instant. Windows already does this unconditionally in Rust .setup() as
  // a hang workaround — skip here to avoid double-building.
  const preloadMiniPlayer = useAuthStore(s => s.preloadMiniPlayer);
  useEffect(() => {
    if (IS_WINDOWS || !preloadMiniPlayer) return;
    invoke('preload_mini_player').catch(() => {});
  }, [preloadMiniPlayer]);

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
      const { exportNewAlbumsImage } = await import('../utils/exportNewAlbums');
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
    <WindowVisibilityProvider>
      <BrowserRouter>
        <PasteClipboardHandler />
        <TauriEventBridge />
        <Suspense fallback={null}>
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
        </Suspense>
        {exportPickerOpen && <ExportPickerModal onConfirm={handleExport} onClose={() => setExportPickerOpen(false)} />}
        <ZipDownloadOverlay />
        <FpsOverlay />
      </BrowserRouter>
    </WindowVisibilityProvider>
  );
}
