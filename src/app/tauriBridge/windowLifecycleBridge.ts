import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { endOrbitSession, leaveOrbitSession, useOrbitStore } from '@/features/orbit';
import { playListenSessionFinalize } from '@/features/playback/store/playListenSession';
import { playbackReportStopped } from '@/features/playback/store/playbackReportSession';
import { flushPlayQueuePosition } from '@/features/playback/store/queueSync';
import { exitApp, pauseRendering, windowLifecycleReady } from '@/lib/api/platformShell';
import { useAuthStore } from '@/store/authStore';
import { getWindowKind } from '@/app/windowKind';

let setupPromise: Promise<void> | null = null;
let exitPromise: Promise<void> | null = null;

function withTimeout(work: Promise<unknown>): Promise<unknown> {
  return Promise.race([work, new Promise(resolve => setTimeout(resolve, 1500))]);
}

function performExit(): Promise<void> {
  if (exitPromise) return exitPromise;
  exitPromise = (async () => {
    await withTimeout(playListenSessionFinalize('close'));
    await withTimeout(playbackReportStopped());
    await withTimeout(flushPlayQueuePosition());
    const role = useOrbitStore.getState().role;
    if (role === 'host' || role === 'guest') {
      const teardown = role === 'host' ? endOrbitSession() : leaveOrbitSession();
      await withTimeout(teardown.catch(() => {}));
    }
    await exitApp();
  })();
  return exitPromise;
}

async function registerWindowLifecycleListeners(): Promise<void> {
  await listen('window:close-requested', async () => {
    if (useAuthStore.getState().minimizeToTray) {
      await pauseRendering().catch(() => {});
      await getCurrentWindow().hide();
      return;
    }
    await performExit();
  });

  await listen('app:force-quit', performExit);
  await windowLifecycleReady();
}

/** Register lifecycle listeners before React mounts and acknowledge queued closes. */
export function setupWindowLifecycleBridge(): Promise<void> {
  if (getWindowKind() !== 'main') return Promise.resolve();
  setupPromise ??= registerWindowLifecycleListeners().catch(() => {});
  return setupPromise;
}
