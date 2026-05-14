import { useNavigate } from 'react-router-dom';
import { useZipDownloadBridge } from '../hooks/tauriBridge/useZipDownloadBridge';
import { usePreviewBridge } from '../hooks/tauriBridge/usePreviewBridge';
import { useAudioDeviceBridge } from '../hooks/tauriBridge/useAudioDeviceBridge';
import { useCliBridge } from '../hooks/tauriBridge/useCliBridge';
import { useTrayIconSync } from '../hooks/tauriBridge/useTrayIconSync';
import { useInAppKeybindings } from '../hooks/tauriBridge/useInAppKeybindings';
import { useMediaAndWindowBridge } from '../hooks/tauriBridge/useMediaAndWindowBridge';
import { usePlayerSnapshotPublisher } from '../hooks/tauriBridge/usePlayerSnapshotPublisher';

/**
 * Single mount point for everything that bridges Rust ↔ React in the main
 * webview: ZIP download progress, track-preview lifecycle, audio output device
 * switches, the full `cli:*` listener surface (instant-mix, library / server
 * resolution, search, player commands), tray-icon visibility, in-app
 * keybindings, media keys + tray actions + window-close / force-quit flow, and
 * the `psysonic --info` snapshot publisher. Renders null — pure side effects.
 *
 * Each concern lives in its own hook under `hooks/tauriBridge/`; this component
 * just composes them.
 *
 * Lives outside `AppShell` so the listeners are attached before `RequireAuth`
 * gates the rest of the tree.
 */
export function TauriEventBridge() {
  const navigate = useNavigate();

  useZipDownloadBridge();
  usePreviewBridge();
  useAudioDeviceBridge();
  useCliBridge(navigate);
  useTrayIconSync();
  useInAppKeybindings(navigate);
  useMediaAndWindowBridge(navigate);
  usePlayerSnapshotPublisher();

  return null;
}

export default TauriEventBridge;
