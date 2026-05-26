import { initAudioListeners } from '../store/initAudioListeners';
import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { showToast } from '../utils/ui/toast';
import { WindowVisibilityProvider } from '../hooks/useWindowVisibility';
import { DragDropProvider } from '../contexts/DragDropContext';
import PasteClipboardHandler from '../components/PasteClipboardHandler';
import ExportPickerModal from '../components/ExportPickerModal';
import ZipDownloadOverlay from '../components/ZipDownloadOverlay';
import FpsOverlay from '../components/FpsOverlay';
import { useAuthStore } from '../store/authStore';
import { useLibraryIndexStore } from '../store/libraryIndexStore';
import { useGlobalShortcutsStore } from '../store/globalShortcutsStore';
import { initHotCachePrefetch } from '../hotCachePrefetch';
import { initMiniPlayerBridgeOnMain } from '../utils/miniPlayerBridge';
import { runAdvancedModeMigration } from '../utils/migrations/advancedModeMigration';
import { bootstrapAllIndexedServers } from '../utils/library/librarySession';
import { hydrateQueueFromIndex } from '../utils/library/queueRestore';
import { useLibraryAnalysisBackfill } from '../hooks/useLibraryAnalysisBackfill';
import { useCoverArtPrefetch } from '../cover/useCoverArtPrefetch';
import { useLibraryCoverBackfill } from '../hooks/useLibraryCoverBackfill';
import { useCoverRevalidateScheduler } from '../cover/useCoverRevalidateScheduler';
import { runCoverIdbUpgradeMigration } from '../utils/migrations/coverIdbUpgradeMigration';
import { useMigrationOrchestrator } from '../hooks/useMigrationOrchestrator';
import { IS_WINDOWS } from '../utils/platform';
import TauriEventBridge from './TauriEventBridge';
import AppShell from './AppShell';
import BlockingMigrationGate from './BlockingMigrationGate';
import RequireAuth from './RequireAuth';
import { useMigrationStore } from '../store/migrationStore';

const Login = lazy(() => import('../pages/Login'));

/**
 * Main webview tree. Hosts the router, the application shell (sidebar /
 * player bar / queue panel / main scroll viewport), the Tauri event bridge,
 * and all background lifecycle hooks (audio listeners, hot-cache prefetch,
 * global shortcuts, mini-player bridge, easter egg, scrollbar auto-hide).
 */
export default function MainApp() {
  const [exportPickerOpen, setExportPickerOpen] = useState(false);

  // One-time bridge from the per-tab Advanced group (v1.46) to the global
  // Advanced Mode toggle. Idempotent — flagged in localStorage.
  useEffect(() => { runAdvancedModeMigration(); }, []);

  // Re-bind the library sync session whenever the active server changes
  // (covers app startup + server switch). The session is Rust
  // process-memory only while the per-server index toggle persists, so
  // without this the background scheduler + Sync now report
  // "no bound session" after a restart.
  const activeServerId = useAuthStore(s => s.activeServerId);
  const serverIdsKey = useAuthStore(s => s.servers.map(srv => srv.id).join(','));
  const masterEnabled = useLibraryIndexStore(s => s.masterEnabled);
  const migrationPhase = useMigrationStore(s => s.phase);
  const migrationReady = migrationPhase === 'completed';
  useMigrationOrchestrator();
  useEffect(() => {
    if (!migrationReady) return;
    void (async () => {
      await bootstrapAllIndexedServers();
      void hydrateQueueFromIndex();
    })();
  }, [activeServerId, serverIdsKey, masterEnabled, migrationReady]);

  useLibraryAnalysisBackfill(migrationReady);
  useCoverArtPrefetch(migrationReady);
  useLibraryCoverBackfill(migrationReady);
  useCoverRevalidateScheduler(migrationReady);

  useEffect(() => {
    if (!migrationReady) return;
    void runCoverIdbUpgradeMigration();
  }, [migrationReady]);

  // Push playback state to mini window + handle control events.
  useEffect(() => {
    return initMiniPlayerBridgeOnMain();
  }, []);

  // Optionally pre-create the mini player webview hidden so the first open
  // is instant. Windows already does this unconditionally in Rust .setup() as
  // a hang workaround — skip here to avoid double-building.
  const preloadMiniPlayer = useAuthStore(s => s.preloadMiniPlayer);
  useEffect(() => {
    if (!migrationReady || IS_WINDOWS || !preloadMiniPlayer) return;
    invoke('preload_mini_player').catch(() => {});
  }, [preloadMiniPlayer, migrationReady]);

  useEffect(() => {
    if (!migrationReady) return undefined;
    return initAudioListeners();
  }, [migrationReady]);

  useEffect(() => {
    if (!migrationReady) return undefined;
    return initHotCachePrefetch();
  }, [migrationReady]);

  useEffect(() => {
    if (!migrationReady) return;
    useGlobalShortcutsStore.getState().registerAll();
  }, [migrationReady]);

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
      const { exportNewAlbumsImage } = await import('../utils/export/exportNewAlbums');
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
        <BlockingMigrationGate>
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
        </BlockingMigrationGate>
      </BrowserRouter>
    </WindowVisibilityProvider>
  );
}
