import { useEffect } from 'react';
import { DragDropProvider } from '@/lib/dnd/DragDropContext';
import MiniPlayer from '@/features/miniPlayer';
import GlobalConfirmModal from '@/ui/GlobalConfirmModal';
import TooltipPortal from '@/ui/TooltipPortal';
import FpsOverlay from '@/app/FpsOverlay';
import { useThemeStore } from '../store/themeStore';
import { useFontStore } from '../store/fontStore';
import { useKeybindingsStore } from '../store/keybindingsStore';
import { usePerfProbeFlags } from '@/lib/perf/perfFlags';
import i18n from '@/lib/i18n';

/**
 * Mini-player webview tree. Rendered in the secondary Tauri window labelled
 * "mini" — no router, no sidebar, no full audio listeners. The window listens
 * for state pushes from the main webview (via the storage event below) and
 * sends control events back through the mini-player bridge.
 */
export default function MiniPlayerApp() {
  const perfFlags = usePerfProbeFlags();

  // Both webviews share localStorage (same origin), so the `storage` event
  // fires in this window whenever main mutates a persisted key — but Zustand
  // persist only reads localStorage on initial load, hence the explicit
  // rehydrate.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (!e.key) return;
      if (e.key === 'psysonic_theme') useThemeStore.persist.rehydrate();
      else if (e.key === 'psysonic_font') useFontStore.persist.rehydrate();
      else if (e.key === 'psysonic_keybindings') useKeybindingsStore.persist.rehydrate();
      else if (e.key === 'psysonic_language' && e.newValue) {
        i18n.changeLanguage(e.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return (
    <DragDropProvider>
      <MiniPlayer />
      <GlobalConfirmModal />
      {!perfFlags.disableTooltipPortal && <TooltipPortal />}
      <FpsOverlay />
    </DragDropProvider>
  );
}
